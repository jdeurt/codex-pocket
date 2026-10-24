import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { currentRelease, installLauncher, selectRelease } from "./install-commands.mjs";
import { optionalFile, replaceFile } from "./install-files.mjs";
import path from "node:path";

const OMIT = new Set([".git", ".local", ".next", "node_modules", "test-results", "playwright-report", "coverage"]);

/** Copy authored files into an isolated release without traversing live state or build products.
@param {string} root - Owning checkout.
@param {string} release - New private release directory.
@returns {Promise<void>} Completion of the source snapshot.
*/
async function copySources(root, release) {
  const entries = await readdir(root);

  for (const name of entries) {
    if (!OMIT.has(name) && !name.endsWith(".tsbuildinfo") && (name === ".env.example" || !name.startsWith(".env"))) {
      await cp(path.join(root, name), path.join(release, name), { recursive: true, verbatimSymlinks: true });
    }
  }
}

/** Switch a validated release, restoring configuration before restarting the old service on failure.
@param {string} root - Private Pocket home containing the shared configuration.
@param {string} release - Fully built candidate.
@param {{ stop: () => void | Promise<void>, start: (release: string) => void | Promise<void>, restore: () => void | Promise<void> }} service - Owned login service operations.
@returns {Promise<void>} Completion of activation or automatic recovery.
*/
async function activate(root, release, service) {
  const file = path.join(root, ".env.local");
  const previous = await optionalFile(file);
  const priorRelease = await currentRelease(root);
  const candidate = await readFile(path.join(release, ".env.local"));

  await replaceFile(path.join(release, ".rollback.env"), previous);
  await symlink(process.execPath, path.join(release, ".pocket-node"));
  await installLauncher(root);
  await rm(path.join(release, ".env.local"));
  await symlink(file, path.join(release, ".env.local"));

  await (async () => {
    await service.stop();
    await replaceFile(file, candidate);
    await service.start(release);
    await selectRelease(root, release);
  })().catch(async (/** @type {unknown} */ error) => {
    await (async () => {
      await service.stop();
      await replaceFile(file, previous);
      await selectRelease(root, priorRelease);
      await service.restore();
    })().catch((/** @type {unknown} */ recoveryError) => {
      throw new AggregateError(
        [error, recoveryError],
        "Pocket activation and recovery failed; saved releases are retained.",
        { cause: recoveryError }
      );
    });

    throw error;
  });
}

/** Allocate a private candidate after creating its parent directory.
@param {string} releases - Private release collection.
@returns {Promise<string>} Unique candidate directory.
*/
async function createRelease(releases) {
  await mkdir(releases, { recursive: true, mode: 0o700 });

  return mkdtemp(path.join(releases, "release-"));
}

/** Reject incomplete candidates before any service operation.
@param {string} release - Candidate runtime directory.
@returns {Promise<void>} Completion of the production output guard.
*/
export async function requireBuild(release) {
  const id = await readFile(path.join(release, ".next", "BUILD_ID"), "utf8");

  if (!id.trim()) {
    throw new Error("The candidate has no completed production build.");
  }
}

/** Build in isolation and change the running installation only after every build gate succeeds.
@param {string} source - Authored source checkout.
@param {string} root - Private Pocket home.
@param {(release: string) => void | Promise<void>} build - Dependency, setup, check and production build gates.
@param {{ stop: () => void | Promise<void>, start: (release: string) => void | Promise<void>, restore: () => void | Promise<void> }} service - Owned login service operations.
@returns {Promise<string>} Activated release path; failed candidates are removed unless recovery failed.
*/
export async function installRelease(source, root, build, service) {
  const release = await createRelease(path.join(root, "releases"));
  const saved = await optionalFile(path.join(root, ".env.local"));

  return (async () => {
    await copySources(source, release);
    await replaceFile(path.join(release, ".env.local"), saved);
    await build(release);

    await requireBuild(release);

    await activate(root, release, service);

    return release;
  })().catch(async (/** @type {unknown} */ error) => {
    if (!(error instanceof AggregateError)) {
      await rm(release, { recursive: true, force: true });
    }

    throw error;
  });
}

/** Prevent concurrent installers from promoting different builds over the same service.
@param {string} root - Private Pocket home.
@param {() => void | Promise<void>} operation - Complete installer transaction.
@returns {Promise<void>} Completion with the exclusive installation lock released.
*/
export async function withInstallLock(root, operation) {
  const lock = path.join(root, "install.lock");

  await mkdir(path.dirname(lock), { recursive: true });

  await (async () => mkdir(lock))().catch((/** @type {unknown} */ error) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Another installer is active. If it was interrupted, remove ~/.pocket/install.lock before retrying.",
        { cause: error }
      );
    }

    throw error;
  });

  await (async () => operation())().finally(async () => {
    await rm(lock, { recursive: true, force: true });
  });
}

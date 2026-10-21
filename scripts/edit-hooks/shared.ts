import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

export interface ToolEvent {
  session_id: string;
  turn_id?: string;
  tool_use_id: string;
  cwd?: string;
  tool_name: string;
  tool_input?: unknown;
}
export type Snapshot = Record<string, string>;
export const ROOT = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".scss",
  ".ts",
  ".tsx",
  ".toml",
  ".yaml",
  ".yml",
]);
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 100;
const LOCK_START_GRACE_MS = 1000;
const STATUS_PATH_OFFSET = 3;

/**
Safe, concise text for a known hook failure.
*/
export class HookFailure extends Error {}

/** Read Git metadata without a shell or quoted tool input.
@param args - Git subcommand and arguments.
@returns Git's raw output.
*/
function git(...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
}

/** Hash file bytes or identifiers without storing source contents.
@param content - Bytes to hash.
@returns SHA-256 in hexadecimal.
*/
function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** List Git-visible paths, including modified tracked and new untracked files.
@returns Sorted formatter candidates.
*/
function statusPaths(): string[] {
  const entries = git("status", "--porcelain=v1", "-z", "--untracked-files=all").toString("utf8").split("\0");
  const candidates = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const relative = entry.slice(STATUS_PATH_OFFSET);

    if (!entry) {
      continue;
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }

    if (EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      candidates.add(relative);
    }
  }

  return [...candidates].toSorted((left, right) => left.localeCompare(right));
}

/** Read file metadata while treating absent paths as ineligible.
@param absolute - Candidate path.
@returns File metadata or null.
*/
async function fileInfo(absolute: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(absolute);
  } catch {
    return null;
  }
}

/** Resolve one regular file inside this worktree without following symlinks.
@param relative - Git-relative path.
@returns Absolute path, or null for absent or unsafe files.
*/
async function safeFile(relative: string): Promise<string | null> {
  const absolute = path.resolve(ROOT, relative);
  const info = await fileInfo(absolute);

  if (!absolute.startsWith(`${ROOT}${path.sep}`) || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return null;
  }

  return (await realpath(absolute)) === absolute ? absolute : null;
}

/** Hash a Git-visible file if it still exists.
@param relative - Git-relative path.
@returns File content digest, or null.
*/
export async function fileHash(relative: string): Promise<string | null> {
  const absolute = await safeFile(relative);

  return absolute ? hash(await readFile(absolute)) : null;
}

/** Record the bytes of already dirty files before a tool runs.
@param targets - Declared paths, or null for snapshot-based detection.
@returns Path-to-digest snapshot.
*/
export async function snapshot(targets: string[] | null = null): Promise<Snapshot> {
  const entries = await Promise.all(
    statusPaths()
      .filter((relative) => targets === null || targets.includes(relative))
      .map(async (relative) => [relative, await fileHash(relative)] as const)
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

/** Locate worktree-owned hook state outside tracked source files.
@returns Private state directory.
*/
export async function stateDirectory(): Promise<string> {
  const directory = path.join(git("rev-parse", "--absolute-git-dir").toString("utf8").trim(), "pocket-edit-hooks");

  await mkdir(directory, { recursive: true, mode: 0o700 });

  return directory;
}

/** Hash one tool identity without putting identifiers in filenames.
@param event - Native tool event.
@returns Private state basename.
*/
export function stateName(event: ToolEvent): string {
  return `${hash(`${event.session_id}:${event.tool_use_id}`)}.json`;
}

/** Create a lock and clean up if its owner marker cannot be written.
@param lock - Worktree runner lock directory.
*/
async function createLock(lock: string): Promise<void> {
  await mkdir(lock);

  try {
    await writeFile(path.join(lock, "owner"), String(process.pid), { mode: 0o600 });
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
}

/** Read the lock owner without treating an unfinished marker as stale.
@param lock - Worktree runner lock directory.
@returns Owner PID or null.
*/
async function lockOwner(lock: string): Promise<number | null> {
  try {
    return Number(await readFile(path.join(lock, "owner"), "utf8"));
  } catch {
    return null;
  }
}

/** Check whether the lock owner is still alive.
@param owner - Owner PID.
@returns True unless the OS confirms the process is gone.
*/
function isRunning(owner: number): boolean {
  try {
    process.kill(owner, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Recover an abandoned lock only when its owner is gone or marker aged out.
@param lock - Worktree runner lock directory.
@returns Whether a stale lock was removed.
*/
async function hasClearedStaleLock(lock: string): Promise<boolean> {
  const owner = await lockOwner(lock);
  const hasOwner = owner !== null && Number.isSafeInteger(owner) && owner > 0;

  let isStale = hasOwner && !isRunning(owner);

  if (!hasOwner) {
    try {
      const lockInfo = await stat(lock);

      isStale = Date.now() - lockInfo.mtimeMs > LOCK_START_GRACE_MS;
    } catch {
      return false;
    }
  }

  if (isStale) {
    await rm(lock, { recursive: true, force: true });
  }

  return isStale;
}

/** Claim the per-worktree runner lock.
@param directory - Private worktree Git state directory.
@param attempts - Maximum attempts before returning informational failure.
@returns Lock directory to remove on completion.
*/
export async function acquireLock(directory: string, attempts = LOCK_ATTEMPTS): Promise<string> {
  const lock = path.join(directory, "runner.lock");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await createLock(lock);

      return lock;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      if (await hasClearedStaleLock(lock)) {
        continue;
      }

      await setTimeout(LOCK_WAIT_MS);
    }
  }

  throw new HookFailure("another after-edit check is still running");
}

/** Write a previously checked regular file.
@param absolute - Safe file path.
@param expected - Digest before writing.
@param content - Proposed content.
@returns New digest and rewrite status.
*/
async function writeKnownFile(absolute: string, expected: string, content: string): Promise<[string, boolean]> {
  const latest = await readFile(absolute, "utf8");

  if (hash(latest) !== expected) {
    throw new HookFailure("an edited file changed during checking");
  }

  if (latest === content) {
    return [expected, false];
  }

  await writeFile(absolute, content);

  return [hash(content), true];
}

/** Write a formatter result only if the source still matches its input.
@param relative - Git-relative file path.
@param expected - Digest of the formatter's source.
@param content - Proposed final content.
@returns New digest and whether a rewrite happened.
*/
export async function writeIfUnchanged(
  relative: string,
  expected: string,
  content: string
): Promise<[string, boolean]> {
  const absolute = await safeFile(relative);

  if (!absolute || (await fileHash(relative)) !== expected) {
    throw new HookFailure("an edited file changed during checking");
  }

  return writeKnownFile(absolute, expected, content);
}

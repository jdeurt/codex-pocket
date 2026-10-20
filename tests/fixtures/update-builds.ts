import { execFile } from "node:child_process";
import { fixtureBuild } from "./next-server";
import { promisify } from "node:util";

const BUILD_TIMEOUT_MS = 180_000;
const OUTPUT_BYTES = 16_000_000;

/**
Compile two genuinely different UI bundles once for the production update browser suite.
*/
export default async function buildUpdates() {
  for (const version of ["a", "b"] as const) {
    const build = await fixtureBuild(`update-${version}`);

    await promisify(execFile)(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: OUTPUT_BYTES,
      env: { ...process.env, ...build, CODEX_THREAD_ID: "", POCKET_BUILD_VERSION: `update-fixture-${version}` },
    });
  }
}

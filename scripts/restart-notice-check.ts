import { t as captureResult } from "try";
import { mkdir, writeFile } from "node:fs/promises";
import { RestartHost } from "../tests/fixtures/restart-host";
import path from "node:path";
import { restartScenarios } from "../tests/fixtures/restart-scenarios";

/**
Owns the private fake bridge process for all restart scenarios and joins it on failure.
@param directory - Fresh private directory containing empty native history.
@returns Completion of the existing native restart workflow and process cleanup.
*/
async function check(directory: string) {
  const host = new RestartHost(directory);

  const completed = await captureResult(restartScenarios(host, directory));

  if (host.isRunning) {
    await host.stop();
  }

  if (!completed.ok) {
    throw completed.error;
  }
}

/**
Creates disposable fake history before starting any native bridge process.
@returns Completion of the isolated restart integration check.
*/
async function restartCheck() {
  const directory = path.resolve(".local", "restart-notice-check", crypto.randomUUID());

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fake-history.json"), "[]");
  await check(directory);
}

await restartCheck();

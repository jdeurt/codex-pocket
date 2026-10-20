import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const localDirectory = () =>
  path.resolve(/* turbopackIgnore: true */ process.env.CODEX_POCKET_STATE_DIR ?? ".local");

export async function writeLocal(name: string, data: unknown) {
  const file = path.resolve(localDirectory(), name);

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;

  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

export async function readLocal(name: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(/* turbopackIgnore: true */ path.resolve(localDirectory(), name), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

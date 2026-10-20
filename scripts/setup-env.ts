import { chmod, readFile, rename, writeFile } from "node:fs/promises";

const PRIVATE_FILE_MODE = 0o600;

export function setupOrigin(value: string) {
  if (!value.trim()) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Use a complete HTTPS address, or leave the phone address empty for local setup.");
  }

  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Use an HTTPS origin without a path, credentials, query or fragment.");
  }

  return url.origin;
}

export function formatEnvironment(source: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error("Environment settings must use valid names and single-line values.");
    }

    const delimiter = ["'", "`", '"'].find((candidate) => !value.includes(candidate));

    if (!delimiter) {
      throw new Error("Environment value contains unsupported quote characters.");
    }

    const entry = `${key}=${delimiter}${value.replaceAll("$", String.raw`\$`)}${delimiter}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");

    source = pattern.test(source) ? source.replace(pattern, () => entry) : `${source.trimEnd()}\n${entry}\n`;
  }

  return source.trimStart();
}

export async function saveSetupEnvironment(file: string, values: Record<string, string>) {
  let source = "";

  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const temporary = `${file}.${crypto.randomUUID()}.tmp`;

  await writeFile(temporary, formatEnvironment(source, values), { mode: PRIVATE_FILE_MODE });
  await rename(temporary, file);
  await chmod(file, PRIVATE_FILE_MODE);
}

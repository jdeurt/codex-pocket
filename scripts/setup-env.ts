import { chmod, readFile, rename, writeFile } from "node:fs/promises";

const PRIVATE_FILE_MODE = 0o600;

/**
Validates a nonempty phone URL and returns its origin.
@param value - Nonempty entered phone address.
@returns HTTPS origin without credentials or URL suffixes.
*/
function httpsOrigin(value: string) {
  const url = URL.parse(value.trim());

  if (!url) {
    throw new Error("Use a complete HTTPS address, or leave the phone address empty for local setup.");
  }

  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Use an HTTPS origin without a path, credentials, query or fragment.");
  }

  return url.origin;
}

/**
Parses an optional phone origin and rejects credentials or non-origin URL components.
@param value - Entered HTTPS origin, or whitespace for local-only setup.
@returns Canonical origin, or undefined for local-only setup.
*/
export function setupOrigin(value: string) {
  if (!value.trim()) {
    return;
  }

  return httpsOrigin(value);
}

/**
Chooses a safe dotenv delimiter for an already validated single-line assignment.
@param key - Validated environment name.
@param value - Validated single-line value.
@returns Quoted literal assignment; values containing every delimiter reject.
*/
function quotedEntry(key: string, value: string) {
  const delimiter = ["'", "`", '"'].find((candidate) => !value.includes(candidate));

  if (!delimiter) {
    throw new Error("Environment value contains unsupported quote characters.");
  }

  return `${key}=${delimiter}${value.replaceAll("$", String.raw`\$`)}${delimiter}`;
}

/**
Encodes one single-line environment setting without allowing shell interpolation.
@param key - Uppercase environment variable name.
@param value - Literal single-line value.
@returns Safely quoted assignment; unsupported names or quoting reject.
*/
function environmentEntry(key: string, value: string) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
    throw new Error("Environment settings must use valid names and single-line values.");
  }

  return quotedEntry(key, value);
}

/**
Updates named settings while retaining unrelated lines in the existing environment file.
@param source - Existing dotenv text.
@param values - Literal values to replace or append.
@returns Updated dotenv text without leading whitespace.
*/
export function formatEnvironment(source: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const entry = environmentEntry(key, value);
    const pattern = new RegExp(`^${key}=.*$`, "m");

    source = pattern.test(source) ? source.replace(pattern, () => entry) : `${source.trimEnd()}\n${entry}\n`;
  }

  return source.trimStart();
}

/**
Reads an existing setup file, treating only a missing file as empty.
@param file - Setup environment path.
@returns Saved dotenv text; other filesystem failures reject.
*/
async function readEnvironment(file: string) {
  const [completed] = await Promise.allSettled([readFile(file, "utf8")]);

  if (completed.status === "fulfilled") {
    return completed.value;
  }

  const error: unknown = completed.reason;

  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }

  return "";
}

/**
Atomically replaces setup settings and enforces private file permissions.
@param file - Destination dotenv path.
@param values - Settings to merge into the existing file.
@returns Completion of the private atomic replacement.
*/
export async function saveSetupEnvironment(file: string, values: Record<string, string>) {
  const source = await readEnvironment(file);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;

  await writeFile(temporary, formatEnvironment(source, values), { mode: PRIVATE_FILE_MODE });
  await rename(temporary, file);
  await chmod(file, PRIVATE_FILE_MODE);
}

import { t as captureResult } from "try";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const destination = new URL("../tests/simulators/contracts/", import.meta.url);
const sdkRoot = new URL("../node_modules/@anthropic-ai/claude-agent-sdk/", import.meta.url);

/**
Extract every declaration, including private referenced types, from one published SDK declaration file.
@param name - Installed declaration filename.
@returns Complete declarations and an index of member signatures.
*/
async function declarations(name: string) {
  const source = await readFile(new URL(name, sdkRoot), "utf8");
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);

  return {
    name,
    sha256: createHash("sha256").update(source).digest("hex"),
    declarations: file.statements.map((statement) => ({
      kind: ts.SyntaxKind[statement.kind],
      text: statement.getFullText(file).trim(),
      members:
        ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)
          ? statement.members.map((member) => member.getText(file))
          : [],
    })),
  };
}

/**
Record the whole installed public SDK surface without importing or launching its runtime.
@returns Versioned declarations for all package entrypoints and referenced local types.
*/
async function claudeContract() {
  const packageText = await readFile(new URL("package.json", sdkRoot), "utf8");
  const entries = await readdir(sdkRoot);
  const names = entries.filter((name) => name.endsWith(".d.ts")).toSorted((a, b) => a.localeCompare(b));
  const files = await Promise.all(names.map((name) => declarations(name)));

  return { package: JSON.parse(packageText) as unknown, files };
}

/** Generate and write the native protocol, SDK contracts and provenance together.
@param temporary - Isolated output directory for the native generator.
@param binary - Selected native executable.
*/
async function writeContracts(temporary: string, binary: string) {
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();

  execFileSync(binary, ["app-server", "generate-json-schema", "--experimental", "--out", temporary]);
  await writeFile(
    new URL("codex.json", destination),
    await readFile(path.join(temporary, "codex_app_server_protocol.schemas.json"))
  );
  await writeFile(new URL("claude.json", destination), JSON.stringify(await claudeContract(), null, 2) + "\n");
  await writeFile(
    new URL("provenance.json", destination),
    JSON.stringify(
      {
        codex: version,
        experimental: true,
        codexCommand: "codex app-server generate-json-schema --experimental",
        claudeSource: "@anthropic-ai/claude-agent-sdk package exports and all local .d.ts files",
        docs: ["https://learn.chatgpt.com/docs/app-server", "https://platform.claude.com/docs/en/agent-sdk/typescript"],
      },
      null,
      2
    ) + "\n"
  );
}

/**
Own and remove the native generator's temporary output on every outcome.
*/
async function extract() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pocket-contracts-"));

  const completed = await captureResult(writeContracts(temporary, process.env.CODEX_BINARY ?? "codex"));

  await rm(temporary, { recursive: true, force: true });

  if (!completed.ok) {
    throw completed.error;
  }
}

await extract();

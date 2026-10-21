import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface HookEvent {
  session_id: string;
  turn_id?: string;
  tool_use_id?: string;
  cwd: string;
  hook_event_name?: "Interrupt";
  tool_name?: string;
  tool_input?: Record<string, string>;
}

export const SOURCE = fileURLToPath(new URL("../", import.meta.url));
export const HEADER = "Your edited files were automatically formatted and lint-fixed. The following issues remain:";
export const GUIDANCE = "Fix these issues before continuing. Apply these rules to future edits.";
const hookResponse = z.object({
  hookSpecificOutput: z.object({ hookEventName: z.literal("PostToolUse"), additionalContext: z.string() }),
});

/** Run one subprocess using native command-hook stdin and stdout.
@param executable - Local executable.
@param arguments_ - Process arguments.
@param cwd - Fixture checkout.
@param event - Optional hook input.
@returns Standard output after a successful exit.
*/
export function run(executable: string, arguments_: string[], cwd: string, event?: HookEvent): string {
  return execFileSync(executable, arguments_, {
    cwd,
    input: event ? JSON.stringify(event) : undefined,
    encoding: "utf8",
  });
}

/** Execute the authored TypeScript hook inside a disposable repository.
@param root - Fixture checkout.
@param phase - Before or after hook phase.
@param event - Native-shaped event.
@returns Native hook output.
*/
export function hook(root: string, phase: "before" | "after", event: HookEvent): string {
  return run(
    path.join(root, "node_modules/.bin/tsx"),
    [path.join(root, `scripts/edit-hooks/${phase}-edit.ts`)],
    root,
    event
  );
}

/** Run actual hook processes concurrently with distinct native event input.
@param root - Fixture checkout.
@param phase - Hook phase.
@param event - Native-shaped input.
@returns Hook stdout after a successful exit.
*/
export async function hookAsync(root: string, phase: "before" | "after", event: HookEvent): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(root, "node_modules/.bin/tsx"),
      [path.join(root, `scripts/edit-hooks/${phase}-edit.ts`)],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let output = "";
    let failure = "";

    child.stdout.setEncoding("utf8").on("data", (part: string) => {
      output += part;
    });
    child.stderr.setEncoding("utf8").on("data", (part: string) => {
      failure += part;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`hook exited ${String(code)}: ${failure}`));
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}

/** Create a repository with its own config, source files, and local dependencies.
@returns Disposable checkout path.
*/
export function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pocket-edit-hooks-flow-"));
  const scripts = path.join(root, "scripts/edit-hooks");
  const src = path.join(root, "src");

  mkdirSync(scripts, { recursive: true });
  mkdirSync(src);

  for (const name of ["before-edit.ts", "after-edit.ts", "shared.ts", "tracking.ts", "format.ts", "events.ts"]) {
    copyFileSync(path.join(SOURCE, "scripts/edit-hooks", name), path.join(scripts, name));
  }

  symlinkSync(path.join(SOURCE, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  writeFileSync(path.join(root, ".prettierignore"), "src/ignored.js\n");
  writeFileSync(path.join(root, "prettier.config.mjs"), "export default { semi: true };\n");
  writeFileSync(
    path.join(root, "eslint.config.mjs"),
    'export default [{ ignores: ["dist/**"] }, { files: ["**/*.js"], rules: { "no-unused-vars": "warn", "no-var": "error", "prefer-const": "error", "eqeqeq": "error" } }];\n'
  );
  writeFileSync(path.join(src, "edited.js"), "console.log(1);\n");
  writeFileSync(path.join(src, "dirty.js"), "console.log(2);\n");
  writeFileSync(path.join(src, "ignored.js"), "console.log(3);\n");
  run("git", ["init", "-q"], root);
  run("git", ["add", "."], root);
  run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "base"], root);

  return root;
}

/** Read informational context from one native after-tool response.
@param root - Fixture checkout.
@param event - Native-shaped tool event.
@returns Developer-context message.
*/
export function hookMessage(root: string, event: HookEvent): string {
  return hookResponse.parse(JSON.parse(hook(root, "after", event)) as unknown).hookSpecificOutput.additionalContext;
}

/** Require informational JSON only, with no result-replacing decision.
@param output - Native PostToolUse stdout.
@returns Added developer context.
*/
export function informationalMessage(output: string): string {
  const parsed: unknown = JSON.parse(output);

  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);

  return hookResponse.parse(parsed).hookSpecificOutput.additionalContext;
}

/** Ensure a completed tool claim released private state and runner lock.
@param root - Fixture checkout.
*/
export function assertIdle(root: string): void {
  const gitDirectory = run("git", ["rev-parse", "--absolute-git-dir"], root).trim();
  const directory = path.join(gitDirectory, "pocket-edit-hooks");

  assert.deepEqual(
    readdirSync(directory).filter((name) => name.endsWith(".json") || name.endsWith(".lock")),
    []
  );
}

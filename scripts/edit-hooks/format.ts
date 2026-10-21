import type * as PrettierType from "prettier";
import { HookFailure, ROOT, type Snapshot, fileHash, snapshot, writeIfUnchanged } from "./shared";
import type { ESLint as ESLintType } from "eslint";
import path from "node:path";
import { readFile } from "node:fs/promises";

const HEADER = "Your edited files were automatically formatted and lint-fixed. The following issues remain:";
const GUIDANCE = "Fix these issues before continuing. Apply these rules to future edits.";
const ESLINT_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MAX_DIAGNOSTICS = 20;
const MAX_MESSAGE_LENGTH = 240;

/** Keep feedback on one line without exposing absolute checkout paths.
@param value - Tool or ESLint message.
@returns Bounded message text.
*/
export function clean(value: string): string {
  return value
    .replaceAll(ROOT, ".")
    .replaceAll(/[\r\n\t]+/g, " ")
    .slice(0, MAX_MESSAGE_LENGTH);
}

/** Import the repository formatter with a concise failure.
@returns Prettier module.
*/
async function loadPrettier(): Promise<typeof PrettierType> {
  try {
    return await import("prettier");
  } catch {
    throw new HookFailure("repository-local Prettier is unavailable");
  }
}

/** Compute and apply one Prettier result with an unchanged-source check.
@param relative - Git-relative path.
@param expected - Digest before formatting.
@returns New digest and rewrite status.
*/
async function formatOneUnchecked(relative: string, expected: string): Promise<[string, boolean]> {
  const prettier = await loadPrettier();
  const absolute = path.join(ROOT, relative);
  const original = await readFile(absolute, "utf8");
  const options = (await prettier.resolveConfig(absolute)) ?? {};
  const formatted = await prettier.format(original, { ...options, filepath: absolute });

  return writeIfUnchanged(relative, expected, formatted);
}

/** Format one file while retaining its current digest.
@param relative - Git-relative path.
@param expected - Digest before formatting.
@returns New digest and rewrite status.
*/
async function formatOne(relative: string, expected: string): Promise<[string, boolean]> {
  try {
    return await formatOneUnchecked(relative, expected);
  } catch (error) {
    if (error instanceof HookFailure) {
      throw error;
    }

    throw new HookFailure(`Prettier could not format ${clean(relative)}`);
  }
}

/** Read one formatter candidate and map parser/config failures to safe feedback.
@param prettier - Repository Prettier module.
@param relative - Git-relative path.
@returns File information.
*/
async function fileInfo(prettier: typeof PrettierType, relative: string): Promise<PrettierType.FileInfoResult> {
  try {
    return await prettier.getFileInfo(path.join(ROOT, relative), {
      ignorePath: [path.join(ROOT, ".prettierignore"), path.join(ROOT, ".gitignore")],
      resolveConfig: true,
    });
  } catch {
    throw new HookFailure(`Prettier could not inspect ${clean(relative)}`);
  }
}

/** Format one eligible candidate.
@param prettier - Repository Prettier module.
@param relative - Git-relative path.
@param expected - Digest before formatting.
@returns Format outcome, or null when ignored.
*/
async function formatCandidate(
  prettier: typeof PrettierType,
  relative: string,
  expected: string
): Promise<[string, boolean] | null> {
  const info = await fileInfo(prettier, relative);

  return info.ignored || !info.inferredParser ? null : formatOne(relative, expected);
}

/** Run Prettier first, retaining only paths accepted by ESLint.
@param changed - Files changed by the native tool.
@param expected - Current content digests, updated after each fix.
@returns Formatted paths and whether Prettier rewrote any file.
*/
async function formatFiles(changed: string[], expected: Snapshot): Promise<[string[], boolean]> {
  const prettier = await loadPrettier();
  const eligible: string[] = [];

  let isRewritten = false;

  for (const relative of changed) {
    const absolute = path.join(ROOT, relative);
    const outcome = await formatCandidate(prettier, relative, expected[relative]);

    if (!outcome) {
      continue;
    }

    expected[relative] = outcome[0];
    isRewritten ||= outcome[1];

    if (ESLINT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      eligible.push(absolute);
    }
  }

  return [eligible, isRewritten];
}

/** Format final-file diagnostics, including both ESLint severity classes.
@param results - Lint results after applying auto-fixes.
@returns Sorted and deduplicated diagnostic lines.
*/
function diagnostics(results: ESLintType.LintResult[]): string[] {
  const lines = new Set<string>();

  for (const result of results) {
    const relative = path.relative(ROOT, result.filePath).split(path.sep).join("/");

    for (const message of result.messages) {
      const location = [message.line, message.column].filter((part) => Number.isSafeInteger(part)).join(":");
      const prefix = location ? `${relative}:${location}` : relative;
      const rule = message.ruleId ? ` (${clean(message.ruleId)})` : "";

      lines.add(`${prefix} ${clean(message.message)}${rule}`);
    }
  }

  return [...lines].toSorted((left, right) => left.localeCompare(right)).slice(0, MAX_DIAGNOSTICS);
}

/** Store one ESLint fix and update the expected digest.
@param relative - Git-relative path.
@param expected - Current digest map.
@param output - ESLint fixed content.
@returns Whether a rewrite happened.
*/
async function hasUpdatedFixedFile(relative: string, expected: Snapshot, output: string): Promise<boolean> {
  const [digest, wrote] = await writeIfUnchanged(relative, expected[relative], output);

  expected[relative] = digest;

  return wrote;
}

/** Apply an ESLint auto-fix if its source has not changed.
@param result - Auto-fix result.
@param expected - Current digest map.
@returns Whether ESLint rewrote the file.
*/
async function hasAppliedFix(result: ESLintType.LintResult, expected: Snapshot): Promise<boolean> {
  const relative = path.relative(ROOT, result.filePath);
  const output = result.output;

  return output === undefined ? false : hasUpdatedFixedFile(relative, expected, output);
}

/** Render only final diagnostics with the approved conditional header.
@param results - Final ESLint results.
@param isRewritten - Whether any auto-fix changed a file.
@returns Feedback or null for clean files.
*/
function renderFeedback(results: ESLintType.LintResult[], isRewritten: boolean): string | null {
  const lines = diagnostics(results);

  return lines.length > 0 ? [...(isRewritten ? [HEADER] : []), ...lines, GUIDANCE].join("\n") : null;
}

/** Run ESLint fixes, verify files, then report final-file diagnostics.
@param eslint - Repository ESLint instance.
@param eligible - Only files edited by this tool and supported by ESLint.
@param expected - Digest map after Prettier.
@param isFormatted - Whether Prettier changed at least one file.
@returns Informational feedback or null.
*/
async function lintAndReport(
  eslint: ESLintType,
  eligible: string[],
  expected: Snapshot,
  isFormatted: boolean
): Promise<string | null> {
  const { ESLint } = await import("eslint");
  const fixed = await eslint.lintFiles(eligible);

  let isRewritten = isFormatted;

  for (const result of fixed) {
    const isWrote = await hasAppliedFix(result, expected);

    isRewritten ||= isWrote;
  }

  for (const absolute of eligible) {
    if ((await fileHash(path.relative(ROOT, absolute))) !== expected[path.relative(ROOT, absolute)]) {
      throw new HookFailure("an edited file changed during checking");
    }
  }

  return renderFeedback(await new ESLint({ cwd: ROOT, fix: false }).lintFiles(eligible), isRewritten);
}

/** Apply repository ESLint only after all Prettier writes finish.
@param formattedPaths - Prettier-eligible files.
@param expected - Digests after formatting.
@param isFormatted - Whether Prettier rewrote a file.
@returns Final informational feedback, or null.
*/
async function checkWithEslint(
  formattedPaths: string[],
  expected: Snapshot,
  isFormatted: boolean
): Promise<string | null> {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT, fix: true });
  const eligible: string[] = [];

  for (const absolute of formattedPaths) {
    if (!(await eslint.isPathIgnored(absolute))) {
      eligible.push(absolute);
    }
  }

  return eligible.length === 0 ? null : lintAndReport(eslint, eligible, expected, isFormatted);
}

/** Own the ordered Prettier and ESLint work for changed files.
@param changed - Tool-touched Git paths.
@param current - Post-tool content digest map.
@returns Feedback or null.
*/
async function checkFiles(changed: string[], current: Snapshot): Promise<string | null> {
  const expected = Object.fromEntries(changed.map((relative) => [relative, current[relative]]));
  const [formattedPaths, formatted] = await formatFiles(changed, expected);

  try {
    return await checkWithEslint(formattedPaths, expected, formatted);
  } catch (error) {
    if (error instanceof HookFailure) {
      throw error;
    }

    throw new HookFailure("repository-local ESLint could not check edited files");
  }
}

/** Run the scoped sequential formatter and final linter.
@param previous - Before-tool file digest snapshot.
@param targets - Exact tool targets, or null for snapshot-based detection.
@returns Feedback or null when final files are clean.
*/
export async function checkChanged(previous: Snapshot, targets: string[] | null): Promise<string | null> {
  const current = await snapshot(targets);
  const changed = Object.keys(current).filter((relative) => current[relative] !== previous[relative]);

  return changed.length === 0 ? null : checkFiles(changed, current);
}

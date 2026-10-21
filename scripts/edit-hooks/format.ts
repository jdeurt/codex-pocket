import type * as PrettierType from "prettier";
import { HookFailure, ROOT, type Snapshot, fileHash, snapshot, writeIfUnchanged } from "./shared";
import type { ESLint as ESLintType } from "eslint";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { recordDiagnostics } from "./diagnostics";
import { shouldRecordEditHookDiagnostics } from "./config";

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

/** Record and render only the final post-auto-fix ESLint results.
@param eligible - Paths checked in this edit cycle.
@param isRewritten - Whether fixes rewrote any file.
@returns Informational feedback or null.
*/
async function reportFinal(eligible: string[], isRewritten: boolean): Promise<string | null> {
  const { ESLint } = await import("eslint");
  const finalResults = await new ESLint({ cwd: ROOT, fix: false }).lintFiles(eligible);
  const feedback = renderFeedback(finalResults, isRewritten);

  // The exported constant is an operator switch; its checked-in default is intentionally true.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (shouldRecordEditHookDiagnostics) {
    try {
      await recordDiagnostics(finalResults);
    } catch (error) {
      const reason = error instanceof HookFailure ? error.message : "diagnostics counter could not be updated";

      return [feedback, `Counter recording failed: ${reason}.`].filter((line) => line !== null).join("\n");
    }
  }

  return feedback;
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

  return reportFinal(eligible, isRewritten);
}

/** Filter JavaScript ignored by the repository ESLint policy.
@param eslint - Repository ESLint instance.
@param changed - Tool-touched Git paths.
@returns Paths eligible for Prettier and ESLint.
*/
async function withoutEslintIgnores(eslint: ESLintType, changed: string[]): Promise<string[]> {
  const checked = await Promise.all(
    changed.map(async (relative) =>
      ESLINT_EXTENSIONS.has(path.extname(relative).toLowerCase()) &&
      (await eslint.isPathIgnored(path.join(ROOT, relative)))
        ? null
        : relative
    )
  );

  return checked.filter((relative): relative is string => relative !== null);
}

/** Run the ordered Prettier and ESLint passes after checking ignores.
@param changed - Tool-touched Git paths.
@param current - Post-tool content digest map.
@returns Feedback or null.
*/
async function checkFilesUnchecked(changed: string[], current: Snapshot): Promise<string | null> {
  const expected = Object.fromEntries(changed.map((relative) => [relative, current[relative]]));
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT, fix: true });
  const eligible = await withoutEslintIgnores(eslint, changed);
  const [formattedPaths, formatted] = await formatFiles(eligible, expected);

  return formattedPaths.length === 0 ? null : await lintAndReport(eslint, formattedPaths, expected, formatted);
}

/** Map runtime failures to concise informational feedback.
@param changed - Tool-touched Git paths.
@param current - Post-tool content digest map.
@returns Feedback or null.
*/
async function checkFiles(changed: string[], current: Snapshot): Promise<string | null> {
  try {
    return await checkFilesUnchecked(changed, current);
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

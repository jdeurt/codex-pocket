import { HookFailure, ROOT, type ToolEvent, snapshot, stateDirectory, stateName } from "./shared";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const stateSchema = z.object({
  baseline: z.record(z.string(), z.string()),
  targets: z.array(z.string()).nullable(),
  conflicted: z.boolean(),
});

type ToolState = z.infer<typeof stateSchema>;

/** Normalize a declared tool path to this checkout.
@param value - Path in native tool input.
@param event - Native tool event.
@returns Git-relative path, or null for unsafe paths.
*/
function targetPath(value: string, event: ToolEvent): string | null {
  const absolute = path.resolve(event.cwd ?? ROOT, value);
  const relative = path.relative(ROOT, absolute);

  return relative && relative !== ".." && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)
    ? relative
    : null;
}

/** Parse exact paths declared by an apply_patch invocation.
@param command - Patch text from the native event.
@param event - Native tool event.
@returns Scoped target paths or null.
*/
function patchTargets(command: string, event: ToolEvent): string[] | null {
  const names = [
    ...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
    ...command.matchAll(/^\*\*\* Move to: (.+)$/gm),
  ].map((match) => targetPath(match[1], event));

  return names.length > 0 && names.every((name) => name !== null)
    ? [...new Set(names)].toSorted((left, right) => left.localeCompare(right))
    : null;
}

/** Extract declared files only when the tool input gives exact edit targets.
@param event - Native tool event.
@returns Exact targets, or null when shell or MCP input is not specific.
*/
function targetsFor(event: ToolEvent): string[] | null {
  const input = event.tool_input;

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  if (event.tool_name === "apply_patch") {
    const command: unknown = Reflect.get(input, "command");

    return typeof command === "string" ? patchTargets(command, event) : null;
  }

  if (event.tool_name.startsWith("mcp__")) {
    const values: unknown[] = ["path", "file_path", "filename", "target_path"].map((key): unknown =>
      Reflect.get(input, key)
    );
    const names = values
      .filter((value): value is string => typeof value === "string")
      .map((value) => targetPath(value, event));

    return names.length > 0 && names.every((name) => name !== null)
      ? [...new Set(names)].toSorted((left, right) => left.localeCompare(right))
      : null;
  }

  return null;
}

/** Validate private state before it can determine edit ownership.
@param value - Parsed JSON.
@returns Checked state.
*/
function parseState(value: unknown): ToolState {
  const result = stateSchema.safeParse(value);

  if (!result.success) {
    throw new HookFailure("before-edit snapshot is invalid");
  }

  return result.data;
}

/** Read state for one native tool call.
@param destination - Private state path.
@returns Validated state.
*/
async function readState(destination: string): Promise<ToolState> {
  try {
    return parseState(JSON.parse(await readFile(destination, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof HookFailure) {
      throw error;
    }

    throw new HookFailure("before-edit snapshot is unavailable");
  }
}

/** Write one state atomically so concurrent hooks never see partial JSON.
@param destination - Private state path.
@param state - Snapshot and target information.
*/
async function writeState(destination: string, state: ToolState): Promise<void> {
  const temporary = `${destination}.${String(process.pid)}.tmp`;

  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Save the tool's baseline without changing the native tool decision.
@param event - Native tool event.
*/
export async function before(event: ToolEvent): Promise<void> {
  const directory = await stateDirectory();
  const targets = targetsFor(event);

  await writeState(path.join(directory, stateName(event)), {
    baseline: await snapshot(targets),
    targets,
    conflicted: false,
  });
}

/** Mark overlapping live operations so neither claims the other's edits.
@param directory - Worktree state directory.
@param event - Completed native tool event.
@returns Its baseline and exact targets, or null on overlap.
*/
export async function claim(directory: string, event: ToolEvent): Promise<ToolState | null> {
  const ownName = stateName(event);
  const ownPath = path.join(directory, ownName);
  const [own, entries] = await Promise.all([readState(ownPath), readdir(directory)]);
  const names = entries.filter((name) => name.endsWith(".json") && name !== ownName);

  let isConflicted = own.conflicted;

  for (const name of names) {
    const otherPath = path.join(directory, name);

    let other: ToolState;

    try {
      other = await readState(otherPath);
    } catch {
      continue;
    }

    if (
      own.targets !== null &&
      other.targets !== null &&
      own.targets.every((target) => !other.targets?.includes(target))
    ) {
      continue;
    }

    isConflicted = true;
    await writeState(otherPath, { ...other, conflicted: true });
  }

  return isConflicted ? null : own;
}

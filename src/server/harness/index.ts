import type { AdapterOptions, Harness } from "./types";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";

/**
Select the concrete native adapter while preserving the parent's supplied configuration and callbacks.
@param harness - Explicit native Codex or Claude harness selection.
@param options - Validated child context, native policy and owner callbacks.
@returns Concrete native adapter for this child.
*/
export function createAdapter(harness: Harness, options: AdapterOptions) {
  return harness === "codex" ? new CodexAdapter(options) : new ClaudeAdapter(options);
}

import type { AdapterOptions, Harness } from "./types";
import { ClaudeAdapter } from "./claude";
import { CodexAdapter } from "./codex";

export function createAdapter(harness: Harness, options: AdapterOptions) {
  return harness === "codex" ? new CodexAdapter(options) : new ClaudeAdapter(options);
}

import { readFileSync } from "node:fs";

const VISIBILITY_INSTRUCTIONS = readFileSync(new URL("prompts/visibility.txt", import.meta.url), "utf8");
export const MAIN_INSTRUCTIONS =
  readFileSync(new URL("prompts/main.txt", import.meta.url), "utf8") + "\n" + VISIBILITY_INSTRUCTIONS;
export const SIDE_INSTRUCTIONS =
  readFileSync(new URL("prompts/side.txt", import.meta.url), "utf8") + "\n" + VISIBILITY_INSTRUCTIONS;
export const ADOPTED_SIDE_ORIENTATION = readFileSync(new URL("prompts/side-adopted.txt", import.meta.url), "utf8");

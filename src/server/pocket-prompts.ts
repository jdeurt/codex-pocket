import { readFileSync } from "node:fs";

export const MAIN_INSTRUCTIONS = readFileSync(new URL("prompts/main.txt", import.meta.url), "utf8");
export const SIDE_INSTRUCTIONS = readFileSync(new URL("prompts/side.txt", import.meta.url), "utf8");

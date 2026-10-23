import { readFileSync } from "node:fs";

export const MAIN_INSTRUCTIONS = readFileSync(new URL("prompts/main.txt", import.meta.url), "utf8");
export const SIDE_INSTRUCTIONS = readFileSync(new URL("prompts/side.txt", import.meta.url), "utf8");
export const ADOPTED_SIDE_ORIENTATION = readFileSync(new URL("prompts/side-adopted.txt", import.meta.url), "utf8");

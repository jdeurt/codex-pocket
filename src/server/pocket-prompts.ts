import path from "node:path";
import { readFileSync } from "node:fs";

export const MAIN_INSTRUCTIONS = readFileSync(path.join(process.cwd(), "src/server/prompts/main.txt"), "utf8");
export const SIDE_INSTRUCTIONS = readFileSync(path.join(process.cwd(), "src/server/prompts/side.txt"), "utf8");

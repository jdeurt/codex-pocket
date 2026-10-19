import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export function findClaudeBinary() {
  const configured = process.env.POCKET_CLAUDE_BINARY;
  const name = configured ?? "claude";
  const candidates = name.includes("/")
    ? [path.resolve(name)]
    : [
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, name)),
        ...(configured
          ? []
          : [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]),
      ];

  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);

      return true;
    } catch {
      return false;
    }
  });
}

export function requireClaudeBinary() {
  const binary = findClaudeBinary();

  if (!binary) {
    throw new Error(
      "Install and sign in to Claude Code on this computer, or set POCKET_CLAUDE_BINARY to its executable."
    );
  }

  return binary;
}

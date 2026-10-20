import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
Resolve the configured Claude executable or the existing native PATH and installation candidates.
@returns First executable candidate, or undefined when Claude is unavailable.
*/
export function findClaudeBinary() {
  const configured = process.env.POCKET_CLAUDE_BINARY;
  const name = configured ?? "claude";
  // Executables are resolved on the operator's machine at runtime, outside the app's bundled files.
  const candidates = name.includes("/")
    ? [path.resolve(/* turbopackIgnore: true */ name)]
    : [
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(/* turbopackIgnore: true */ directory, name)),
        ...(configured
          ? []
          : [
              path.join(/* turbopackIgnore: true */ os.homedir(), ".local/bin/claude"),
              "/opt/homebrew/bin/claude",
              "/usr/local/bin/claude",
            ]),
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

/**
Require an executable native Claude installation before acquiring its harness process.
@returns Resolved executable path, or the existing operator setup error.
*/
export function requireClaudeBinary() {
  const binary = findClaudeBinary();

  if (!binary) {
    throw new Error(
      "Install and sign in to Claude Code on this computer, or set POCKET_CLAUDE_BINARY to its executable."
    );
  }

  return binary;
}

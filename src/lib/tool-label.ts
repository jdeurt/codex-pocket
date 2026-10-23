const COMMAND_BOUNDARY = 15;
const MISSING_SPACE = -1;

/**
Convert native tool identifiers into sentence case while retaining acronym boundaries.
@param name - Snake, camel, Pascal or already spaced tool name.
@returns Readable label without a trailing period.
*/
export function toolName(name: string) {
  const words = name
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .replaceAll(/[_\s]+/g, " ")
    .replace(/\.+$/, "")
    .trim()
    .toLowerCase();

  return words ? words[0].toUpperCase() + words.slice(1) : "Tool";
}

/**
Choose a whole-word command preview at the requested fifteen-character boundary.
@param command - Original native command text.
@returns Command prefix ending before the first space at or after that boundary.
*/
export function commandPreview(command: string) {
  const boundary = command.indexOf(" ", COMMAND_BOUNDARY);

  return boundary === MISSING_SPACE ? command : command.slice(0, boundary);
}

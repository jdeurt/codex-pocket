export interface TranscriptFollow {
  isFollowing: boolean;
}

/** Create one transcript's follow preference from its restored bookmark.
@param isFollowing - Whether the saved reader was at the end.
@returns Initial follow state before native interaction.
*/
export function transcriptFollow(isFollowing: boolean): TranscriptFollow {
  return { isFollowing };
}

/** Resume following only when the reader reaches the end.
@param state - Current follow preference.
@param isAtEnd - Whether the native viewport is at the end.
@returns Following at the end, otherwise the unchanged reader preference.
*/
export function scrolledTranscript(state: TranscriptFollow, isAtEnd: boolean): TranscriptFollow {
  return isAtEnd && !state.isFollowing ? { isFollowing: true } : state;
}

/** Select native anchoring from the transcript's single follow preference.
@param shouldOwnFollow - Whether this runtime coordinates outer-transcript following.
@param state - Current reader preference.
@param anchor - Requested native anchor, including covered-parent suspension.
@returns Anchor appropriate to the reader's current position.
*/
export function transcriptAnchor(
  shouldOwnFollow: boolean,
  state: TranscriptFollow,
  anchor: "start" | "end" | undefined
) {
  return shouldOwnFollow && !state.isFollowing ? "start" : anchor;
}

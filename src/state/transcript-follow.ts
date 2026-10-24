export interface TranscriptFollow {
  isFollowing: boolean;
  interacting: boolean;
}

/** Create one transcript's follow preference from its restored bookmark.
@param isFollowing - Whether the saved reader was at the end.
@returns Initial follow state before native interaction.
*/
export function transcriptFollow(isFollowing: boolean): TranscriptFollow {
  return { isFollowing, interacting: false };
}

/** Adopt the end position only when scrolling belongs to a user gesture.
@param state - Current follow preference and gesture ownership.
@param isAtEnd - Whether the native viewport is at the end.
@returns Follow state, unchanged for programmatic layout adjustments.
*/
export function scrolledTranscript(state: TranscriptFollow, isAtEnd: boolean): TranscriptFollow {
  return state.interacting ? { ...state, isFollowing: isAtEnd } : state;
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

export interface SpinnerTone {
  version: 1;
  contrast: number;
  /**
  Additive sRGB brightness offset; applied after contrast in one unclipped operation.
  */
  brightness: number;
}

export interface SavedSpinner {
  id: string;
  mime: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
  createdAt: number;
  tone: SpinnerTone | null;
}

export interface SpinnerPreference {
  current: SavedSpinner | null;
}

export interface SpinnerLibrary extends SpinnerPreference {
  saved: SavedSpinner[];
}

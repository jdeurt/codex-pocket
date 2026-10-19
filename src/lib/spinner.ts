export interface SavedSpinner {
  id: string;
  mime: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
  createdAt: number;
}

export interface SpinnerPreference {
  current: SavedSpinner | null;
}

export interface SpinnerLibrary extends SpinnerPreference {
  saved: SavedSpinner[];
}

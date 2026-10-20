import { z } from "zod";

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

export const spinnerToneSchema = z.object({ version: z.literal(1), contrast: z.number(), brightness: z.number() });
export const savedSpinnerSchema = z.object({
  id: z.string(),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  frames: z.number(),
  bytes: z.number(),
  createdAt: z.number(),
  tone: spinnerToneSchema.nullable(),
});
export const spinnerPreferenceSchema = z.object({ current: savedSpinnerSchema.nullable() });
export const spinnerLibrarySchema = spinnerPreferenceSchema.extend({ saved: z.array(savedSpinnerSchema) });

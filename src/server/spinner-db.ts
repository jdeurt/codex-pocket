export { PRIVATE_FILE_MODE } from "./private-database";
import { privateDatabase } from "./private-database";
import { chmodSync, mkdirSync } from "node:fs";
import { savedSpinnerSchema, spinnerToneSchema } from "../lib/spinner";
import path from "node:path";
import { z } from "zod";

const PRIVATE_DIRECTORY_MODE = 0o700;
export const storedSpinnerSchema = savedSpinnerSchema.omit({ tone: true }).extend({
  tone: z
    .string()
    .nullable()
    .transform((value) => (value ? spinnerToneSchema.parse(JSON.parse(value)) : null)),
});
export const COLUMNS = "id,mime,width,height,frames,bytes,createdAt,tone";

export const assetInfoSchema = z.object({ mime: z.string(), digest: z.string(), tone: z.string().nullable() });

/**
Open the private spinner catalog and migrate its optional tone column.
@param filename - SQLite file inside the private Pocket directory.
@returns The initialized native database.
*/
function spinnerDatabase(filename: string) {
  return privateDatabase(
    filename,
    `
      CREATE TABLE IF NOT EXISTS spinner_assets (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, mime TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, frames INTEGER NOT NULL,
        bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spinner_preference (singleton INTEGER PRIMARY KEY CHECK(singleton=1), activeId TEXT);
      INSERT OR IGNORE INTO spinner_preference VALUES (1,NULL);
    `,
    { migration: { table: "spinner_assets", column: "tone", sql: "ALTER TABLE spinner_assets ADD COLUMN tone TEXT" } }
  );
}

/**
Create private managed-asset storage before opening its catalog.
@param directory - Private Pocket state directory.
@returns The managed asset directory and initialized catalog.
*/
export function spinnerStorage(directory: string) {
  const assets = path.join(directory, "spinner-assets");

  mkdirSync(assets, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(assets, PRIVATE_DIRECTORY_MODE);

  return { assets, db: spinnerDatabase(path.join(directory, "spinners.sqlite")) };
}

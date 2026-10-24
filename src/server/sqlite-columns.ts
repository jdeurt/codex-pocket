import type { Database } from "better-sqlite3";
import { z } from "zod";

const columnsSchema = z.array(z.object({ name: z.string() }));

/** Apply a host-authored migration only while its marker column is absent.
@param db - Owning native database, already inside its migration transaction.
@param table - Static table name supplied by application code.
@param column - Column marking the migration's completion.
@param sql - Complete static migration SQL.
*/
export function migrateColumns(db: Database, table: string, column: string, sql: string) {
  const columns = columnsSchema.parse(db.pragma(`table_info(${table})`));

  for (const existing of columns) {
    if (existing.name === column) {
      return;
    }
  }

  db.exec(sql);
}

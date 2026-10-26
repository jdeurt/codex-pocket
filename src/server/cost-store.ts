import { mkdirSync } from "node:fs";
import path from "node:path";
import { t } from "try";
import { costObservationSchema, costGroupSchema, type CostObservation, type CostQuery } from "../lib/costs";
import { validatedCostQuery } from "../state/costs";
import { privateDatabase } from "./private-database";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import type Database from "better-sqlite3";
import { z } from "zod";
import { valueAfterCleanup } from "../lib/results";

/** Open the private accounting ledger; it stores no prompts, output text, or credentials.
@param directory - Explicit private accounting directory.
@returns An owned SQLite handle, safe to share across Pocket processes.
*/
function openCosts(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return privateDatabase(
    path.join(directory, "costs.sqlite"),
    `
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, feature TEXT NOT NULL,
      model TEXT NOT NULL, provider TEXT NOT NULL, record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS observation_time ON observations(timestamp);
    CREATE INDEX IF NOT EXISTS observation_filters ON observations(feature,model,timestamp);
  `
  );
}

/** Upsert a stable provider observation, preserving its initial accounting timestamp.
@param observation - Validated content-free usage metadata.
@param directory - Explicit private accounting directory.
*/
function writeCost(observation: CostObservation, directory: string) {
  const record = costObservationSchema.parse(observation);
  const db = openCosts(directory);
  const statement = db.prepare(`INSERT INTO observations VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET record=excluded.record`);
  const saved = t(
    statement.run.bind(statement),
    record.id,
    record.timestamp,
    record.feature,
    record.model,
    record.provider,
    JSON.stringify(record)
  );

  valueAfterCleanup(saved, t(db.close.bind(db)));
}

/** Record accounting without interrupting accepted work when local accounting storage fails.
@param observation - Content-free native or provider accounting observation.
@param directory - Private application state root; fixtures supply their own root.
*/
export function observeCost(observation: CostObservation, directory = localDirectory()) {
  const written = t(writeCost, observation, directory);

  if (!written.ok) {
    log().warn({ error: written.error }, "costs.write_failed");
  }
}

/** Bind the viewer's timezone to SQLite's deterministic calendar grouping.
@param formatter - Calendar formatter configured once for this report timezone.
@param timestamp - Stored UTC accounting instant.
@returns Sortable local calendar date.
*/
function calendarCostDay(formatter: Intl.DateTimeFormat, timestamp: string) {
  return formatter.format(new Date(timestamp));
}

/** Query disjoint daily contributions inside SQLite instead of loading a year of raw events.
@param db - Owned accounting connection.
@param query - Validated bounded interval and filters.
@returns Content-free dashboard report.
*/
function queriedCosts(db: Database.Database, query: CostQuery) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: query.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  db.function("cost_day", { deterministic: true }, calendarCostDay.bind(undefined, formatter));
  const statement = db.prepare(`SELECT cost_day(timestamp) AS day,
    feature, model, provider, COUNT(*) AS calls,
    SUM(json_extract(record,'$.amountUSD') IS NULL) AS unknownCosts,
    SUM(json_extract(record,'$.status')='pending') AS pending,
    SUM(json_extract(record,'$.costKind')='reported' AND
      json_extract(record,'$.amountUSD') IS NOT NULL) AS reportedRecords,
    SUM(json_extract(record,'$.status') IN ('failed','aborted')) AS failed,
    SUM(CASE WHEN json_extract(record,'$.costKind')='estimated'
      THEN json_extract(record,'$.amountUSD') ELSE 0 END) AS estimatedUSD,
    SUM(CASE WHEN json_extract(record,'$.costKind')='reported'
      THEN json_extract(record,'$.amountUSD') ELSE 0 END) AS reportedUSD,
    COALESCE(SUM(json_extract(record,'$.inputTokens')),0) AS inputTokens,
    COALESCE(SUM(json_extract(record,'$.outputTokens')),0) AS outputTokens,
    COALESCE(SUM(json_extract(record,'$.cachedInputTokens')),0) AS cachedInputTokens,
    COALESCE(SUM(json_extract(record,'$.seconds')),0) AS seconds
    FROM observations WHERE timestamp>=? AND timestamp<?
      AND (? IS NULL OR feature=?) AND (? IS NULL OR provider || '/' || model=?)
    GROUP BY day,feature,model,provider ORDER BY day`);
  const rows = statement.all(
    query.start,
    query.end,
    query.feature ?? null,
    query.feature ?? null,
    query.model ?? null,
    query.model ?? null
  );
  const groups = z.array(costGroupSchema).parse(rows);
  const models = z
    .array(z.object({ model: z.string() }))
    .parse(db.prepare("SELECT DISTINCT provider || '/' || model AS model FROM observations ORDER BY model").all());
  const first = z
    .object({ timestamp: z.string().nullable() })
    .parse(db.prepare("SELECT MIN(timestamp) AS timestamp FROM observations").get());
  const sources = z.array(z.object({ source: z.string() })).parse(
    db
      .prepare(
        `SELECT DISTINCT json_extract(record,'$.pricingSource') AS source
      FROM observations WHERE timestamp>=? AND timestamp<?
      AND json_extract(record,'$.pricingSource') IS NOT NULL`
      )
      .all(query.start, query.end)
  );
  const pricingSources: string[] = [];
  const modelNames: string[] = [];

  for (const source of sources) {
    pricingSources.push(source.source);
  }

  for (const model of models) {
    modelNames.push(model.model);
  }

  return {
    query,
    generatedAt: new Date().toISOString(),
    trackingSince: first.timestamp,
    models: modelNames,
    groups,
    pricingSources,
  };
}

/** Read bounded aggregate accounting without exposing per-request identities to the browser.
@param requested - Browser interval and optional contribution filters.
@param directory - Private application state root; never supplied through HTTP.
@returns Daily contributions, available models and coverage metadata.
*/
export function readCostReport(requested: CostQuery, directory = localDirectory()) {
  const query = validatedCostQuery(requested);
  const db = openCosts(directory);
  const result = t(queriedCosts, db, query);

  return valueAfterCleanup(result, t(db.close.bind(db)));
}

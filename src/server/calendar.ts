import ICAL from "ical.js";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_CALENDAR_LENGTH = 16_384;
const CALCULATION_TIMEOUT_MS = 2000;
const DATE_PARTS = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;
const TIME_PROPERTIES = new Set(["dtstart", "rdate", "exdate"]);
const RULE_FIELDS = new Set([
  "FREQ",
  "UNTIL",
  "COUNT",
  "INTERVAL",
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);
const NONZERO_FIELDS = new Set(["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYSETPOS"]);
const SUPPORTED_PROPERTIES = new Set([
  ...TIME_PROPERTIES,
  "rrule",
  "uid",
  "dtstamp",
  "summary",
  "description",
  "dtend",
  "duration",
]);

function validateDate(value: string) {
  const parts = DATE_PARTS.exec(value);

  if (!parts) {
    throw new Error("Use date-times with seconds, such as 20261020T090000Z; all-day dates are unsupported.");
  }

  const [, year, month, day, hour, minute, second] = parts;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);

  if (
    !Number.isFinite(date.getTime()) ||
    date
      .toISOString()
      .replaceAll(/[-:]/g, "")
      .slice(0, value.length - (value.endsWith("Z") ? 1 : 0)) !== value.replace(/Z$/, "")
  ) {
    throw new Error(`Invalid calendar date-time: ${value}`);
  }
}

function validateRule(line: string) {
  const parts = line
    .slice(line.indexOf(":") + 1)
    .split(";")
    .map((part) => part.split("="));
  const rule = new Map(parts.map(([key, value]) => [key, value]));

  if (
    new Set(parts.map(([key]) => key)).size !== parts.length ||
    parts.some(([key, value]) => !RULE_FIELDS.has(key) || !value)
  ) {
    throw new Error("RRULE contains an unknown, duplicated or empty field.");
  }

  for (const [key, value] of parts) {
    if (NONZERO_FIELDS.has(key) && value.split(",").some((part) => Number(part) === 0)) {
      throw new Error(`${key} cannot contain zero.`);
    }
  }

  if (rule.has("COUNT") && rule.has("UNTIL")) {
    throw new Error("RRULE cannot contain both COUNT and UNTIL.");
  }

  for (const field of ["COUNT", "INTERVAL"]) {
    const value = rule.get(field);

    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < 1)) {
      throw new Error(`${field} must be a positive integer.`);
    }
  }

  const until = rule.get("UNTIL");

  if (!until) {
    return;
  }

  validateDate(until);

  if (!until.endsWith("Z")) {
    throw new Error("UNTIL must be a UTC date-time ending in Z.");
  }
}

export function normalizeCalendar(input: string) {
  if (!input.trim() || input.length > MAX_CALENDAR_LENGTH) {
    throw new Error("Supply iCalendar event text of at most 16 KiB.");
  }

  const unfolded = input.trim().replaceAll(/\r?\n[ \t]/g, "");

  // Validate before ICAL can normalize values such as INTERVAL=0 into defaults.
  for (const line of unfolded.split(/\r?\n/)) {
    if (/^RRULE:/i.test(line)) {
      validateRule(line.toUpperCase());
    } else if (/^(?:DTSTART|RDATE|EXDATE)[:;]/i.test(line)) {
      for (const date of line.slice(line.indexOf(":") + 1).split(",")) {
        validateDate(date);
      }
    }
  }

  const wrapped = /^BEGIN:/i.test(unfolded) ? unfolded : `BEGIN:VEVENT\n${unfolded}\nEND:VEVENT`;
  const root = ICAL.Component.fromString(wrapped);
  const events = root.name === "vcalendar" ? root.getAllSubcomponents("vevent") : [root];

  if (
    events.length !== 1 ||
    events[0].name !== "vevent" ||
    events[0].getAllSubcomponents().length > 0 ||
    (root.name === "vcalendar" && root.getAllSubcomponents().length !== 1)
  ) {
    throw new Error("Supply exactly one VEVENT without nested events, alarms or custom timezones.");
  }

  const event = events[0];

  if (event.getAllProperties("dtstart").length !== 1 || event.getAllProperties("rrule").length > 1) {
    throw new Error("An event needs exactly one DTSTART and at most one RRULE.");
  }

  const lines: string[] = [];

  for (const property of event.getAllProperties()) {
    if (!SUPPORTED_PROPERTIES.has(property.name)) {
      throw new Error(`Unsupported calendar property: ${property.name}`);
    }

    if (TIME_PROPERTIES.has(property.name)) {
      const line = property.toICALString();
      const separator = line.indexOf(":");
      const zone: unknown = property.getParameter("tzid");

      if (zone !== undefined && typeof zone !== "string") {
        throw new Error("TZID must be a single IANA timezone name.");
      }

      if (zone) {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      }

      for (const value of line.slice(separator + 1).split(",")) {
        validateDate(value);

        if ((!zone && !value.endsWith("Z")) || (zone && value.endsWith("Z"))) {
          throw new Error("Use UTC dates ending in Z, or local dates with an IANA TZID, consistently.");
        }
      }

      lines.push(line);
    } else if (property.name === "rrule") {
      const line = property.toICALString();

      lines.push(line);
    }
  }

  // rrule's parser needs a rule to include DTSTART in a single-occurrence set.
  if (!event.hasProperty("rrule")) {
    lines.push("RRULE:FREQ=DAILY;COUNT=1");
  }

  return lines.join("\n");
}

export async function nextOccurrence(calendar: string, after: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("scripts/calendar-worker.mjs")], {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let diagnostic = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Calendar recurrence took too long to evaluate. Simplify the rule."));
    }, CALCULATION_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      diagnostic += String(data);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`Invalid calendar recurrence: ${diagnostic.trim()}`));

        return;
      }

      try {
        const value: unknown = JSON.parse(output);

        if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= after)) {
          throw new Error("Calendar returned an invalid next occurrence.");
        }

        resolve(value);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid calendar response.", { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify({ calendar, after }));
  });
}

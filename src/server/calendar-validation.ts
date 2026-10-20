import ICAL from "ical.js";

const MAX_CALENDAR_LENGTH = 16_384;
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

/**
Reject normalized-overflow dates after the strict native date-time pattern has matched.
@param value - Exact source date-time whose calendar fields must remain unchanged.
@param parts - Native RegExp captures for the required year, month, day, hour, minute and second fields.
*/
function validateDateParts(value: string, parts: RegExpExecArray) {
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

/**
Require a complete supported date-time before checking its actual calendar fields.
@param value - Untrusted iCalendar date-time field from an allowed source property.
*/
function validateDate(value: string) {
  const parts = DATE_PARTS.exec(value);

  if (!parts) {
    throw new Error("Use date-times with seconds, such as 20261020T090000Z; all-day dates are unsupported.");
  }

  validateDateParts(value, parts);
}

/**
Require any recurrence UNTIL value to be a valid UTC date-time.
@param rule - Validated native recurrence fields after count and interval checks.
*/
function validateUntil(rule: Map<string, string>) {
  const until = rule.get("UNTIL");

  if (!until) {
    return;
  }

  validateDate(until);

  if (!until.endsWith("Z")) {
    throw new Error("UNTIL must be a UTC date-time ending in Z.");
  }
}

/**
Validate recurrence fields before ICAL can normalize invalid values into defaults.
@param line - Uppercase source RRULE line retaining its original field values.
*/
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

  validateUntil(rule);
}

/**
Validate unfolded recurrence and time fields before native ICAL parsing normalizes them.
@param unfolded - Unfolded source event text within the shared length limit.
*/
function validateSourceLines(unfolded: string) {
  // Validate before ICAL can normalize values such as INTERVAL=0 into defaults.
  const sourceLines = unfolded.split(/\r?\n/);

  for (const line of sourceLines) {
    if (/^RRULE:/i.test(line)) {
      validateRule(line.toUpperCase());
    } else if (/^(?:DTSTART|RDATE|EXDATE)[:;]/i.test(line)) {
      const dates = line.slice(line.indexOf(":") + 1).split(",");

      for (const date of dates) {
        validateDate(date);
      }
    }
  }
}

/**
Require exactly one native event without nested alarms, events or custom timezone definitions.
@param unfolded - Source event text whose raw recurrence and time fields have already been checked.
@returns The single native ICAL event component.
*/
function calendarEvent(unfolded: string) {
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

  return events[0];
}

/**
Require each native date value to agree with its property's explicit UTC or IANA-zone form.
@param values - Source date values extracted from one native time property.
@param zone - Validated scalar IANA timezone parameter, when supplied.
*/
function validateZonedDates(values: string[], zone: string | undefined) {
  for (const value of values) {
    validateDate(value);

    if ((!zone && !value.endsWith("Z")) || (zone && value.endsWith("Z"))) {
      throw new Error("Use UTC dates ending in Z, or local dates with an IANA TZID, consistently.");
    }
  }
}

/**
Validate one native time property's timezone and exact date values before retaining its serialized line.
@param property - Native ICAL time property selected by the allowed property set.
@returns Existing native iCalendar line after timezone and date validation.
*/
function timeProperty(property: ICAL.Property) {
  const line = property.toICALString();
  const separator = line.indexOf(":");
  const zone: unknown = property.getParameter("tzid");

  if (zone !== undefined && typeof zone !== "string") {
    throw new Error("TZID must be a single IANA timezone name.");
  }

  if (zone) {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  }

  validateZonedDates(line.slice(separator + 1).split(","), zone);

  return line;
}

/**
Retain only supported recurrence and time lines in their original native property order.
@param event - Single native event with required start and recurrence cardinality already checked.
@returns Normalized recurrence lines, including the existing single-occurrence fallback rule.
*/
function eventProperties(event: ICAL.Component) {
  const lines: string[] = [];
  const properties = event.getAllProperties();

  for (const property of properties) {
    if (!SUPPORTED_PROPERTIES.has(property.name)) {
      throw new Error(`Unsupported calendar property: ${property.name}`);
    }

    if (TIME_PROPERTIES.has(property.name)) {
      lines.push(timeProperty(property));
    } else if (property.name === "rrule") {
      lines.push(property.toICALString());
    }
  }

  // rrule's parser needs a rule to include DTSTART in a single-occurrence set.
  if (!event.hasProperty("rrule")) {
    lines.push("RRULE:FREQ=DAILY;COUNT=1");
  }

  return lines;
}

/**
Require one start and at most one recurrence before projecting supported native properties.
@param event - Single native event without nested components.
@returns Normalized recurrence text for the bounded native worker.
*/
function eventLines(event: ICAL.Component) {
  if (event.getAllProperties("dtstart").length !== 1 || event.getAllProperties("rrule").length > 1) {
    throw new Error("An event needs exactly one DTSTART and at most one RRULE.");
  }

  return eventProperties(event).join("\n");
}

/**
Keep source validation ahead of native parsing and normalized recurrence projection.
@param unfolded - Unfolded event text within the public input limit.
@returns Validated recurrence text preserving the existing native date and timezone semantics.
*/
function validatedCalendar(unfolded: string) {
  validateSourceLines(unfolded);

  return eventLines(calendarEvent(unfolded));
}

/**
Bound and validate one iCalendar event before it can create a persisted schedule.
@param input - Untrusted event text from the schedule boundary.
@returns Normalized recurrence text, or the existing date, timezone, shape or rule validation error.
*/
export function normalizeCalendar(input: string) {
  if (input.length > MAX_CALENDAR_LENGTH || !input.trim()) {
    throw new Error("Supply iCalendar event text of at most 16 KiB.");
  }

  return validatedCalendar(input.trim().replaceAll(/\r?\n[ \t]/g, ""));
}

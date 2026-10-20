# Scheduled tasks

Ask Pocket to do something later, such as “Every weekday at 9 a.m. Los Angeles time, summarize the open tasks in this project.” Give a timezone and ask it to confirm the schedule. You can ask it to list, change, pause, or delete tasks in the same conversation.

The Mac must be awake with Pocket running. After downtime, Pocket delivers one overdue occurrence per task, then advances a recurring task to its next future occurrence. It does not replay every missed repetition. A one-time task becomes inactive after firing.

## Tool reference

The main Pocket has these MCP tools: `schedule_create`, `schedule_list`, `schedule_get`, `schedule_update` and `schedule_delete`. A schedule has a `title`, a `body` containing the instructions to send later, a `calendar` string and an optional `active` boolean. Update accepts `changes` and an optional `expectedRevision`; read the latest revision before editing.

## Calendar format

Calendar text is iCalendar/RFC 5545: a single VEVENT or VCALENDAR containing one VEVENT, or just DTSTART and recurrence properties. Use seconds and either UTC `Z` or an IANA `TZID`. Floating times, all-day dates, custom timezones, nested alarms, multiple events and unsupported properties are rejected. Recurrence evaluation has a two-second limit.

One-time example (replace the date with a future instant):

```text
DTSTART:20261020T160000Z
```

Weekday example (replace the starting date and timezone):

```text
DTSTART;TZID=America/Los_Angeles:20261020T090000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
```

RRULE supports recurrence fields such as COUNT or UTC UNTIL, and RDATE/EXDATE add or exclude occurrences. Ask the agent to read the computer's current date and confirm the intended timezone before creating an event. An active schedule must have a future occurrence. Enable/disable uses `active: true` or `false`.

## Delivery and missed runs

When due, Pocket silently injects the body into the real Codex chat using the same steering/queueing mode as phone messages. The trigger, title and injected user-message body stay hidden from the phone, including queued tasks and reloaded history. The agent's responses, questions and approval requests appear normally, and its responses can mention task details.

Schedules and immutable delivery history live in owner-private `~/.pocket/data/schedules.sqlite` with SQLite WAL. Keep the database and its `-wal`/`-shm` files across updates; use SQLite backup facilities for a consistent live backup. Deleting a task cancels future occurrences and pending deliveries, while retaining delivery history so previous triggers remain hidden. Messages already accepted or in flight cannot be recalled.

After a restart, scheduled deliveries reuse each run's durable message ID. An uncertain Codex acknowledgment is retained for inspection rather than automatically replayed. Diagnose `schedule.*` events alongside the matching outbox receipt before retrying anything.

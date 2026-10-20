import rrule from "rrule";

let input = "";

for await (const chunk of process.stdin) {
  input += String(chunk);
}

try {
  const { calendar, after } = JSON.parse(input);
  const rule = rrule.rrulestr(calendar, { forceset: true, compatible: true });
  const next = rule.after(new Date(after));

  process.stdout.write(next ? JSON.stringify(next.getTime()) : "null");
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

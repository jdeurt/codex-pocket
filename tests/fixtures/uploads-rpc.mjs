// Offline integration fixture: no real harness session or credentials are used.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setInterval, setTimeout } from "node:timers";
import { createInterface } from "node:readline";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CONTROL_POLL_MS = 75;
const RECOVERY_DURATION_MS = 100;
const PNG_SIGNATURE_LENGTH = 8;
const directory = process.env.POCKET_UPLOAD_REPLAY;
const historyFile = path.join(directory, "history.json");
const controlFile = path.join(directory, "control.json");

async function read(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const thread = await read(historyFile, { id: "upload-replay-parent", name: "Upload replay", turns: [] });
const initialControl = await read(controlFile, {});
const controls = { last: initialControl.id };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const event = (method, params) => send({ method, params: { threadId: thread.id, ...params } });
const save = () => writeFile(historyFile, JSON.stringify(thread));

async function complete(turn) {
  turn.status = "completed";
  event("turn/completed", { turn });
  await save();
}

setInterval(async () => {
  const control = await read(controlFile, {});

  if (!control.id || control.id === controls.last) {
    return;
  }

  controls.last = control.id;

  if (control.action === "disconnect") {
    process.kill(process.pid, "SIGTERM");

    return;
  }

  if (control.action === "duplicate-image") {
    const turn = thread.turns.findLast((entry) =>
      entry.items.some((item) => item.content?.some((part) => part.type === "localImage"))
    );
    const item = turn?.items.findLast((entry) => entry.content?.some((part) => part.type === "localImage"));

    if (turn && item) {
      item.images = [
        { source: item.content.find((part) => part.type === "localImage").path, alt: "Duplicate upload preview" },
      ];
      item.fixtureDuplicateImage = true;
      event("item/completed", { turnId: turn.id, item });
      await save();
    }

    return;
  }

  if (control.action !== "complete") {
    return;
  }

  for (const turn of thread.turns) {
    if (turn.status === "inProgress") {
      await complete(turn);
    }
  }
}, CONTROL_POLL_MS);

async function readableInput(input) {
  if (input.type === "localImage") {
    const file = await readFile(input.path);

    if (file.subarray(0, PNG_SIGNATURE_LENGTH).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Unreadable native image input");
    }

    return { type: input.type, path: input.path, size: file.length };
  }

  if (input.type !== "text") {
    throw new Error(`Unsupported input type ${input.type}`);
  }

  if (!input.text.startsWith("Attached file on this computer")) {
    return;
  }

  const reference = JSON.parse(input.text.split("\n", 2)[1]);
  const file = await readFile(reference.path);

  if (file.length !== reference.size) {
    throw new Error("Unreadable file reference");
  }

  return { ...reference, base64: file.toString("base64") };
}

async function deliver(method, params) {
  const bytes = [];

  for (const input of params.input) {
    const readable = await readableInput(input);

    if (readable) {
      bytes.push(readable);
    }
  }

  await appendFile(path.join(directory, "requests.jsonl"), JSON.stringify({ method, ...params, bytes }) + "\n");
  const item = {
    id: `item-${params.clientUserMessageId}`,
    type: "userMessage",
    clientId: params.clientUserMessageId,
    content: params.input,
  };
  let turn =
    method === "turn/steer"
      ? thread.turns.find((entry) => entry.id === params.expectedTurnId && entry.status === "inProgress")
      : undefined;

  if (!turn) {
    turn = { id: randomUUID(), status: "inProgress", items: [] };
    thread.turns.push(turn);
    event("turn/started", { turn: { ...turn, items: [] } });
  }

  turn.items.push(item);
  await save();
  event("item/completed", { turnId: turn.id, item });

  if (params.clientUserMessageId.startsWith("pocket-recovery:")) {
    setTimeout(() => void complete(turn), RECOVERY_DURATION_MS);
  }

  return { turn };
}

async function execute(method, params) {
  switch (method) {
    case "initialize": {
      return {};
    }

    case "config/read": {
      return { config: { sandbox_mode: "danger-full-access", approval_policy: "never", model: "fake-uploads" } };
    }

    case "thread/resume": {
      return { thread, model: "fake-uploads", reasoningEffort: "high" };
    }

    case "thread/read": {
      return { thread };
    }

    case "thread/turns/list": {
      return { data: thread.turns, nextCursor: null };
    }

    case "turn/start":
    case "turn/steer": {
      return deliver(method, params);
    }

    default: {
      throw new Error(`Unexpected fixture method ${method}`);
    }
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  if (request.id === undefined) {
    continue;
  }

  try {
    const result = await execute(request.method, request.params ?? {});
    send({ id: request.id, result });
  } catch (error) {
    send({ id: request.id, error: { code: -32_000, message: error.message } });
  }
}

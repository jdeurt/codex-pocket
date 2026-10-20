// Offline integration fixture: no real harness session or credentials are used.
import {
  type Data,
  type Item,
  type Thread,
  type Turn,
  itemSchema,
  threadSchema,
  turnSchema,
} from "../../src/lib/protocol";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fixtureFileReferenceSchema, fixtureUploadInputSchema } from "./replay-protocol";
import { readFixtureRequests, writeFixtureRecord } from "./sequential-rpc";
import { setInterval, setTimeout } from "node:timers";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const CONTROL_POLL_MS = 75;
const RECOVERY_DURATION_MS = 100;
const PNG_SIGNATURE_LENGTH = 8;

type UploadItem = Item & { content?: z.infer<typeof fixtureUploadInputSchema>[] };
type UploadTurn = Omit<Turn, "items"> & { items: UploadItem[] };
type UploadHistory = Omit<Thread, "turns"> & { turns: UploadTurn[] };
const uploadItemSchema = itemSchema.and(z.object({ content: z.array(fixtureUploadInputSchema).optional() }));
const uploadTurnSchema: z.ZodType<UploadTurn> = turnSchema.and(z.object({ items: z.array(uploadItemSchema) }));
const uploadHistorySchema: z.ZodType<UploadHistory> = threadSchema.and(z.object({ turns: z.array(uploadTurnSchema) }));
const controlSchema = z.object({ id: z.string().optional(), action: z.string().optional() });
const deliverySchema = z
  .object({
    input: z.array(fixtureUploadInputSchema),
    clientUserMessageId: z.string(),
    expectedTurnId: z.string().optional(),
  })
  .loose();

const directory = z.string().parse(process.env.POCKET_UPLOAD_REPLAY);
const historyFile = path.join(directory, "history.json");
const controlFile = path.join(directory, "control.json");

/**
Restores canonical upload turns from this private replay's saved native history.
@param file - Private replay history path.
@returns Validated history, or the original empty replay when reading or validation fails.
*/
async function readHistory(file: string) {
  try {
    return uploadHistorySchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return uploadHistorySchema.parse({ id: "upload-replay-parent", name: "Upload replay", turns: [] });
  }
}

/**
Reads the fake host's current control command without consulting live state.
@returns Validated control record, or an empty record before a command exists.
*/
async function readControl() {
  try {
    return controlSchema.parse(JSON.parse(await readFile(controlFile, "utf8")));
  } catch {
    return {};
  }
}

const thread = await readHistory(historyFile);
const initialControl = await readControl();
const controls = { last: initialControl.id };

/**
Publishes a native notification scoped to this synthetic parent.
@param method - Native event method.
@param params - Already normalized event fields.
*/
function event(method: string, params: Data) {
  writeFixtureRecord({ method, params: { threadId: thread.id, ...params } });
}

/**
Persists canonical synthetic turns for reconnect and recovery.
@returns Completion of the private history write.
*/
function save() {
  return writeFile(historyFile, JSON.stringify(thread));
}

/**
Marks a synthetic turn complete, publishes its event and persists it.
@param turn - Canonical upload turn owned by this replay.
@returns Completion of the durable history write.
*/
async function complete(turn: UploadTurn) {
  turn.status = "completed";
  event("turn/completed", { turn });
  await save();
}

/**
Injects a duplicate image representation into the latest uploaded native item.
@returns Completion of the fake event and persistence, or no operation when no image exists.
*/
async function duplicateImage() {
  const turn = thread.turns.findLast((entry) =>
    entry.items.some((item) => item.content?.some((part) => part.type === "localImage"))
  );
  const item = turn?.items.findLast((entry) => entry.content?.some((part) => part.type === "localImage"));

  const image = item?.content?.find((part) => part.type === "localImage");

  if (!turn || !item || !image) {
    return;
  }

  item.images = [{ source: image.path, alt: "Duplicate upload preview" }];
  item.fixtureDuplicateImage = true;
  event("item/completed", { turnId: turn.id, item });
  await save();
}

/**
Applies each new fake-host control once, including disconnect and completion.
@returns Completion of this control pass.
*/
async function applyControl() {
  const control = await readControl();

  if (!control.id || control.id === controls.last) {
    return;
  }

  controls.last = control.id;

  if (control.action === "disconnect") {
    process.kill(process.pid, "SIGTERM");

    return;
  }

  if (control.action === "duplicate-image") {
    await duplicateImage();

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
}

/**
Reads an attached file path and proves the original byte length at the replay boundary.
@param text - Native attachment-reference text emitted by the app.
@returns Validated file receipt with its original base64 bytes.
*/
async function readableReference(text: string) {
  const reference = fixtureFileReferenceSchema.parse(JSON.parse(text.split("\n", 2)[1] ?? ""));
  const file = await readFile(reference.path);

  if (file.length !== reference.size) {
    throw new Error("Unreadable file reference");
  }

  return { ...reference, base64: file.toString("base64") };
}

/**
Reads one normalized native upload input and checks native image signatures.
@param input - Validated text or local-image protocol input.
@returns Original-byte receipt, or undefined for ordinary user text.
*/
async function readableInput(input: z.infer<typeof fixtureUploadInputSchema>) {
  if (input.type === "localImage") {
    const file = await readFile(input.path);

    if (file.subarray(0, PNG_SIGNATURE_LENGTH).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Unreadable native image input");
    }

    return { type: input.type, path: input.path, size: file.length };
  }

  if (!input.text.startsWith("Attached file on this computer")) {
    return;
  }

  return await readableReference(input.text);
}

/**
Appends a normalized submission to a new or active native turn and schedules recovery completion.
@param method - Native start or steer method.
@param params - Validated submission fields.
@returns Canonical turn containing the submitted input.
*/
async function persistDelivery(method: string, params: z.infer<typeof deliverySchema>) {
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

/**
Reads submitted original files before logging or acknowledging the native delivery.
@param method - Native start or steer method.
@param params - Validated submission fields.
@returns Persisted canonical delivery result.
*/
async function deliver(method: string, params: z.infer<typeof deliverySchema>) {
  const bytes = [];

  for (const input of params.input) {
    const readable = await readableInput(input);

    if (readable) {
      bytes.push(readable);
    }
  }

  await appendFile(path.join(directory, "requests.jsonl"), JSON.stringify({ method, ...params, bytes }) + "\n");

  return await persistDelivery(method, params);
}

/**
Implements the bounded native RPC methods required by offline upload workflows.
@param method - Decoded native method.
@param params - Untrusted parameter record, validated when a delivery method is selected.
@returns Native response; unsupported methods reject.
*/
async function execute(method: string | undefined, params: Data) {
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
      return deliver(method, deliverySchema.parse(params));
    }

    default: {
      throw new Error(`Unexpected fixture method ${String(method)}`);
    }
  }
}

setInterval(() => void applyControl(), CONTROL_POLL_MS);
await readFixtureRequests(execute);

import { type Data, object, string } from "../src/lib/protocol";
import { CodexRpc } from "../src/server/rpc";
import { PiMain } from "../src/server/pi-main";
import { configSchema } from "../src/server/config";
import { createInterface } from "node:readline";
import { log } from "../src/server/logging";
import { readOpenAIApiKey } from "../src/server/pocket-settings";
import { t as attempt } from "try";

const config = configSchema.parse(JSON.parse(process.env.POCKET_PI_CONFIG ?? "null"));
const native = new CodexRpc();

/** Write one host protocol frame; stdout belongs exclusively to Pocket's bridge.
@param value - Canonical protocol notification or response.
*/
function write(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

const main = new PiMain(config, native, write, readOpenAIApiKey, (error) => {
  log().error({ error }, "pi.main_error");
});
const lines = createInterface({ input: process.stdin });

/** Dispatch initialization, supported parent methods and explicit realtime capability failures.
@param method - Host-owned method name.
@param params - Canonical method parameters.
@returns The existing parent protocol response.
*/
async function dispatch(method: string, params: Data): Promise<unknown> {
  if (method === "initialize") {
    await native.connect(config, "bare");

    return { userAgent: "pocket-pi" };
  }

  if (method.startsWith("thread/realtime/")) {
    throw new Error("Pi main sessions require the OpenAI realtime transport; update the Pocket voice integration.");
  }

  return main.request(method, params);
}

/** Validate and dispatch a host request without serializing inference behind its entire run.
@param message - Host-owned JSON-RPC frame.
*/
async function receive(message: Data) {
  if (!message.method && (typeof message.id === "string" || typeof message.id === "number")) {
    main.respond(message.id, message.result);

    return;
  }

  if (message.id === undefined || !message.method) {
    return;
  }

  const dispatched = await attempt(dispatch, string(message.method), object(message.params));
  const written = dispatched.ok ? attempt(write, { id: message.id, result: dispatched.value }) : dispatched;

  if (written.ok) {
    return;
  }

  const detail = written.error instanceof Error ? written.error.message : "Pi request failed.";

  write({ id: message.id, error: { code: -32_600, message: detail } });
}

/**
Stop the owned Pi and native reader processes after host disconnect or termination.
*/
async function close() {
  const completed = await attempt(main.close());

  const closed = await attempt(() => native.shutdown());

  if (!closed.ok) {
    console.error(closed.error);

    return;
  }

  process.stdin.destroy();

  if (!completed.ok) {
    console.error(completed.error);
  }
}

process.once("SIGTERM", () => {
  void close();
});
lines.once("close", () => {
  void close();
});

/** Decode and process one line independently of later stop and steering requests.
@param line - Host protocol frame.
*/
async function receiveLine(line: string) {
  const decoded = attempt(() => object(JSON.parse(line)));
  const received = decoded.ok ? await attempt(receive, decoded.value) : decoded;

  if (!received.ok) {
    console.error(received.error);
  }
}

for await (const line of lines) {
  void receiveLine(line);
}

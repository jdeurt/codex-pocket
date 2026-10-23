import { type Data, object, string } from "../src/lib/protocol";
import { CodexRpc } from "../src/server/rpc";
import { PiMain } from "../src/server/pi-main";
import { configSchema } from "../src/server/config";
import { createInterface } from "node:readline";
import { log } from "../src/server/logging";
import { readOpenAIApiKey } from "../src/server/pocket-settings";

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
  if (message.id === undefined || !message.method) {
    return;
  }

  try {
    const result = await dispatch(string(message.method), object(message.params));

    write({ id: message.id, result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Pi request failed.";

    write({ id: message.id, error: { code: -32_600, message: detail } });
  }
}

/**
Stop the owned Pi and native reader processes after host disconnect or termination.
*/
async function close() {
  try {
    await main.close();
  } finally {
    await native.shutdown();
    process.stdin.destroy();
  }
}

process.once("SIGTERM", () => {
  void close().catch(console.error);
});
lines.once("close", () => {
  void close().catch(console.error);
});

for await (const line of lines) {
  try {
    void receive(object(JSON.parse(line))).catch(console.error);
  } catch (error) {
    console.error(error);
  }
}

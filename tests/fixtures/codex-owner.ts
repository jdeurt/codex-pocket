import { type Data, object, string } from "../../src/lib/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { CodexRpc } from "../../src/server/rpc";
import { CodexSimulator } from "../simulators/codex";
import { CodexStore } from "../simulators/codex-store";
import { CodexTurns } from "../simulators/codex-turns";
import { DelegationStore } from "../../src/server/delegations";
import { type TestContext } from "node:test";
import { configSchema } from "../../src/server/config";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { socketText } from "../../src/server/rpc-transport";
import { validateMessage } from "../simulators/contract";

/**
Start one shared owner with independent client handshakes and real Unix WebSocket connections.
@param t - Test context owning all resources.
@param beforeRead - Optional gate for deterministic native history latency.
@returns Native owner, shared simulator and isolated durable delegate storage.
*/
export async function codexOwner(t: TestContext, beforeRead?: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-own-"));
  const socketPath = path.join(directory, "c.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const clients = new Set<WebSocket>();
  const calls: Data[] = [];
  const native = new CodexStore();
  const broadcast = (message: Data) => {
    validateMessage(string(message.method), message, message.id === undefined ? "ServerNotification" : "ServerRequest");

    for (const client of clients) {
      client.send(JSON.stringify(message));
    }
  };
  const turns = new CodexTurns(native, broadcast, { hold: true, chunks: ["Original owner result"] });
  const owner = new CodexRpc();
  const store = new DelegationStore(directory);
  const config = configSchema.parse({ cwd: directory, threadId: "parent", codexBinary: "/absent-codex" });

  server.on("connection", (socket) => {
    const simulator = new CodexSimulator((message) => {
      if (message.method) {
        broadcast(message);
      } else {
        socket.send(JSON.stringify(message));
      }
    });

    simulator.store = native;
    simulator.turns = turns;
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(socketText(data));

      const receive = async () => {
        if (["thread/read", "thread/turns/list", "thread/items/list"].includes(string(object(message).method))) {
          await beforeRead?.();
        }

        await simulator.receive(message);
      };

      calls.push(object(message));
      void receive();
    });
  });
  t.after(async () => {
    await owner.shutdown();

    for (const socket of clients) {
      socket.terminate();
    }

    server.close();
    http.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  http.listen(socketPath);
  await once(http, "listening");
  await owner.connectSocket(socketPath);
  store.saveParent("parent", { cwd: directory, policy: { sandbox: "read-only", approval: "never" } });

  return { directory, socketPath, owner, store, config, native, turns, calls, clients };
}

/**
Create a held native assignment through the actual protocol boundary.
@param fixture - Shared owning server fixture.
@returns Original thread and active turn identities.
*/
export async function ownedTurn(fixture: Awaited<ReturnType<typeof codexOwner>>) {
  const { thread } = await fixture.owner.request("thread/start", { cwd: fixture.directory, ephemeral: false });
  const { turn } = await fixture.owner.request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "Original assignment", text_elements: [] }],
  });

  return { thread, turn };
}

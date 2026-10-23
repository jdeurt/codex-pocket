import { type PiMain } from "../../src/server/pi-main";
import { object } from "../../src/lib/protocol";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";

/** Host the external control endpoint for real MCP model-switch calls into the owning Pi session.
@param current - Most recently opened session, including reconnects.
@returns Loopback server and isolated origin; callers close it after the SDK flow.
*/
export async function piSessionEndpoint(current: () => PiMain | undefined) {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }

      assert.equal(request.method, "POST");
      assert.ok(request.url?.startsWith("/api/session?"));
      const session = current();

      assert.ok(session);
      const body = Buffer.concat(chunks).toString();
      const settings = object(JSON.parse(body));

      await session.request("thread/settings/update", settings);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ applied: true }));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  assert.ok(address && typeof address !== "string");

  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

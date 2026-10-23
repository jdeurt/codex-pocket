import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { type PiMain } from "../../src/server/pi-main";
import { object } from "../../src/lib/protocol";
import { toolJson } from "./tool-json";
import assert from "node:assert/strict";
import { z } from "zod";

const CONTEXT_WINDOW = 123_456;
const KNOWN_CONTEXT = 8192;
const ALPHA_MODEL_COUNT = 3;
const FIXTURE_ERROR_STATUS = 500;
const ALPHA = "catalog-alpha";
const ALPINE = "catalog-alpine";
const EXACT_MODEL = "exact-model";
const SHARED_NAME = "Shared display name";
const providerSchema = z.array(z.object({ id: z.string(), name: z.string() }).strict());
const legacySchema = z.array(
  z.object({ id: z.string(), name: z.string(), reasoning: z.boolean(), contextWindow: z.number() })
);

/** Install supported native-provider metadata for collision and unknown-context workflow coverage.
@param runtime - Real Pi catalog owned by the production session.
*/
export function registerCatalogFixtures(runtime: ModelRuntime) {
  const alpha = fauxProvider({
    provider: ALPHA,
    models: [
      { id: EXACT_MODEL, name: SHARED_NAME, reasoning: true, contextWindow: CONTEXT_WINDOW },
      { id: "other-model", name: EXACT_MODEL, reasoning: false, contextWindow: KNOWN_CONTEXT },
      { id: "vendor/model", name: SHARED_NAME, reasoning: false, contextWindow: 0 },
    ],
  });
  const alpine = fauxProvider({
    provider: ALPINE,
    models: [{ id: EXACT_MODEL, name: "Alpine Model", reasoning: false, contextWindow: KNOWN_CONTEXT }],
  });

  runtime.registerNativeProvider({ ...alpha.provider, name: "Example Computing" });
  runtime.registerNativeProvider({ ...alpine.provider, name: "Catalog Alpine" });
}

/** Call the registered MCP tool and decode its public result after checking the transport envelope.
@param client - Connected stdio MCP client.
@param input - Tool arguments sent through MCP, HTTP, and the production Pi request dispatcher.
@returns Parsed catalog response.
*/
async function query(client: Client, input: Record<string, unknown>) {
  const result = await client.callTool({ name: "pocket_session_models", arguments: input });

  assert.equal(result.isError, undefined, JSON.stringify(result));

  return object(toolJson(result));
}

/** Verify provider discovery, fuzzy choices, concise defaults, and pagination via the public tool.
@param client - Connected real MCP transport.
*/
async function checkProviders(client: Client) {
  const all = await query(client, { view: "providers", limit: 1 });

  assert.equal(providerSchema.parse(all.providers).length, 1);
  assert.equal(all.nextOffset, 1);
  const ambiguous = await query(client, { provider: "catalog al", limit: 1 });
  const continuation = await query(client, { provider: "catalog al", limit: 1, offset: 1 });

  assert.equal(ambiguous.status, "ambiguous_provider");
  assert.equal(ambiguous.total, 2);
  assert.equal(ambiguous.nextOffset, 1);
  assert.deepEqual(
    providerSchema.parse(ambiguous.providers).map((provider) => provider.id),
    [ALPHA]
  );
  assert.deepEqual(
    providerSchema.parse(continuation.providers).map((provider) => provider.id),
    [ALPINE]
  );
  assert.equal(continuation.nextOffset, null);
  assert.deepEqual(await query(client, { provider: "  CATALOG_ALPHA  " }), await query(client, { provider: ALPHA }));
  assert.deepEqual(await query(client, { provider: "catalog alpa" }), await query(client, { provider: ALPHA }));
  assert.deepEqual(await query(client, { provider: "example computing" }), await query(client, { provider: ALPHA }));
  const fuzzyChoices = await query(client, { provider: "catalog alpe" });

  assert.equal(fuzzyChoices.status, "ambiguous_provider");
  assert.deepEqual(
    providerSchema.parse(fuzzyChoices.providers).map((provider) => provider.id),
    [ALPHA, ALPINE]
  );
  const names = await query(client, { provider: ALPHA, limit: 2 });
  const nextNames = await query(client, { provider: ALPHA, limit: 2, offset: 2 });

  assert.deepEqual(names.provider, { id: ALPHA, name: "Example Computing" });
  assert.deepEqual(names.models, [SHARED_NAME, EXACT_MODEL]);
  assert.equal(names.total, ALPHA_MODEL_COUNT);
  assert.equal(names.nextOffset, 2);
  assert.deepEqual(nextNames.models, [SHARED_NAME]);
  assert.equal(nextNames.nextOffset, null);
  const beyond = await query(client, { provider: ALPHA, offset: 100 });

  assert.deepEqual(beyond.models, []);
  const missing = await query(client, { provider: "zzzz-no-such-provider" });

  assert.equal(missing.status, "provider_not_found");
  assert.deepEqual(missing.providers, []);
}

/** Verify exact identities and metadata through the same entry point used by agents.
@param client - Connected real MCP transport.
*/
async function checkModels(client: Client) {
  const unfiltered = await query(client, {});
  const legacy = legacySchema.parse(unfiltered.models);
  const installed = legacy.find((model) => model.id.startsWith("openai/"));

  assert.ok(installed, "Use an actual installed provider model as well as configured catalog fixtures");
  const installedDetails = await query(client, { model: installed.id });

  assert.deepEqual(installedDetails.model, {
    ...installed,
    provider: "openai",
    modelId: installed.id.slice("openai/".length),
  });
  const exact = await query(client, { provider: ALPHA, model: EXACT_MODEL });

  assert.deepEqual(exact.model, {
    id: `${ALPHA}/${EXACT_MODEL}`,
    modelId: EXACT_MODEL,
    provider: ALPHA,
    name: SHARED_NAME,
    reasoning: true,
    contextWindow: CONTEXT_WINDOW,
  });
  assert.deepEqual(await query(client, { model: `${ALPHA}/${EXACT_MODEL}` }), exact);
  const name = await query(client, { provider: ALPINE, model: "alpine model" });

  assert.equal(object(name.model).modelId, EXACT_MODEL);
  assert.equal(object(name.model).reasoning, false);
  const duplicateId = await query(client, { model: EXACT_MODEL });
  const duplicateName = await query(client, { provider: ALPHA, model: SHARED_NAME, limit: 1 });

  assert.equal(duplicateId.status, "ambiguous_model");
  assert.equal(duplicateId.total, 2);
  assert.equal(duplicateName.status, "ambiguous_model");
  assert.equal(duplicateName.total, 2);
  assert.equal(duplicateName.nextOffset, 1);
  const nested = await query(client, { model: `${ALPHA}/vendor/model` });

  assert.equal(object(nested.model).modelId, "vendor/model");
  assert.equal(object(nested.model).contextWindow, null);
  assert.equal(object(nested.model).reasoning, false);
  const detailed = await query(client, { provider: ALPHA, view: "details", limit: 1 });

  assert.deepEqual(detailed.models, [exact.model]);
  assert.equal(detailed.nextOffset, 1);
  const wrongProvider = await query(client, { provider: ALPINE, model: `${ALPHA}/${EXACT_MODEL}` });

  assert.equal(wrongProvider.status, "model_not_found");
  assert.deepEqual(wrongProvider.models, []);
  const missing = await query(client, { model: "no-such-model" });

  assert.equal(missing.status, "model_not_found");
}

/** Verify registered schema, catalog queries, and rejection at both transport boundaries.
@param client - Connected real MCP client.
@param origin - Loopback control endpoint.
*/
async function verifyCatalogWorkflow(client: Client, origin: string) {
  const { tools } = await client.listTools();
  const catalog = tools.find((tool) => tool.name === "pocket_session_models");

  assert.ok(catalog?.inputSchema.properties?.provider);
  assert.ok(catalog.inputSchema.properties.model);
  await checkProviders(client);
  await checkModels(client);

  for (const input of [{ limit: 101 }, { offset: -1 }, { provider: " " }, { model: EXACT_MODEL, view: "providers" }]) {
    const result = await client.callTool({ name: "pocket_session_models", arguments: input });

    assert.equal(result.isError, true);
  }

  const rejected = await fetch(`${origin}/api/session?catalog=models&limit=0`);

  assert.equal(rejected.status, FIXTURE_ERROR_STATUS);
}

/** Exercise the installed catalog through real MCP calls without altering the session's chosen model.
@param main - Initialized production Pi session.
@param origin - Existing loopback control endpoint.
@param directory - Isolated workflow state directory.
@param parentId - Owning native thread.
*/
export async function checkPiCatalog(main: PiMain, origin: string, directory: string, parentId: string) {
  const before = await main.request("thread/read", { threadId: parentId });
  const client = new Client({ name: "catalog-workflow", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/mcp.ts"],
    cwd: process.cwd(),
    env: {
      POCKET_THREAD_ID: parentId,
      POCKET_SERVER_ORIGIN: origin,
      CODEX_POCKET_STATE_DIR: directory,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await verifyCatalogWorkflow(client, origin);
    assert.deepEqual(await main.request("thread/read", { threadId: parentId }), before);
  } finally {
    await client.close();
  }
}

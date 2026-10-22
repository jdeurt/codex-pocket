import { type SpinnerServer, startSpinnerServer, stopSpinnerServer } from "../fixtures/spinner-server";
import { checkMissingSpinner, checkSpinnerViewport } from "./spinner-viewport";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { SPINNER_ORIGIN } from "../fixtures/browser-defaults";
import assert from "node:assert/strict";
import { checkLegacyTone } from "./spinner-tone-check";
import { createSpinnerSite } from "../fixtures/spinner-site";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "../fixtures/spinner-client";

const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;

const origin = SPINNER_ORIGIN;
const server: SpinnerServer = { directory: "", project: "", output: "" };

/**
Select the actual managed asset and require a current identity from the native MCP response.
@param main - Native MCP client for private spinner storage.
@param uploaded - Original GIF input copied before selection.
@returns Current managed asset after successful selection.
*/
async function selectManagedGif(main: Awaited<ReturnType<typeof spinnerClient>>, uploaded: string) {
  const chosen = await main.call("spinner_set", { path: uploaded });

  if (!chosen.current) {
    throw new Error("Expected custom spinner selection.");
  }

  return chosen.current;
}

/**
Require the public preference route to reveal neither private paths nor the saved library.
@returns Completion of all public preference privacy assertions.
*/
async function assertPublicPreference() {
  const response = await fetch(`${origin}/api/spinner`);
  const publicPreference = await response.text();

  expect(publicPreference).not.toContain(server.directory);
  expect(publicPreference).not.toContain("private-upload");
  expect(publicPreference).not.toContain("saved");
}

/**
Verify native tone migration, exact bytes, ETag, access restrictions and public preference privacy.
@param main - Native MCP client for private spinner storage.
@param uploaded - Original private GIF input.
@returns Managed identity, private URL and conditional request validator.
*/
async function checkManagedRoutes(main: Awaited<ReturnType<typeof spinnerClient>>, uploaded: string) {
  const current = await selectManagedGif(main, uploaded);
  const id = current.id;
  const url = `${origin}/api/spinner/${id}`;
  const response = await checkLegacyTone(main, server.directory, id, url);
  const etag = response.headers.get("etag");

  if (!etag) {
    throw new Error("Managed asset must have an ETag.");
  }

  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(uploaded));
  expect(await fetch(url, { headers: { "if-none-match": etag } })).toHaveProperty("status", HTTP_NOT_MODIFIED);
  expect(await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).toHaveProperty("status", HTTP_NOT_FOUND);
  expect(await fetch(`${origin}/api/spinner/not-a-managed-id`)).toHaveProperty("status", HTTP_NOT_FOUND);
  expect(await fetch(`${origin}/api/spinner?path=${encodeURIComponent(uploaded)}`, { method: "POST" })).toHaveProperty(
    "status",
    HTTP_METHOD_NOT_ALLOWED
  );
  await assertPublicPreference();

  return { id, url, etag };
}

test.beforeAll(async ({ browserName }) => {
  await mkdir(".local", { recursive: true });
  server.directory = await mkdtemp(path.join(os.tmpdir(), "pocket-spinner-browser-"));
  server.project = process.cwd();

  if (browserName === "webkit") {
    // Safari's existing chat scroller can stall forced layouts. Verify this standalone feature
    // against the same Next routes/component/styles without changing that separately owned scroller.
    server.project = await createSpinnerSite();
  }

  server.main = await spinnerClient(server.directory);
  await startSpinnerServer(server, origin);
});

test.afterAll(async () => {
  await stopSpinnerServer(server);
  await writeFile(`.local/spinner-server-${test.info().project.name}.log`, server.output);
  await server.main?.client.close();
  await rm(server.directory, { recursive: true, force: true });

  if (server.project !== process.cwd()) {
    await rm(server.project, { recursive: true, force: true });
  }
});

test("selected GIF renders, persists through restart, and recovers when its managed asset is missing", async ({
  browser,
  browserName,
}) => {
  const uploaded = path.join(server.directory, "private-upload-kirby.gif");
  const { main, id, url, etag } =
    await test.step("Select the original GIF and verify native private asset routes", async () => {
      const client = server.main;

      assert.ok(client);
      await copyFile(path.resolve("tests/fixtures/spinners/kirbyjam.gif"), uploaded);

      return { main: client, ...(await checkManagedRoutes(client, uploaded)) };
    });

  // Restart the real Next process, retaining only this test's private state and fake harness.
  const spinnerLibrary8 =
    await test.step("Render the selected GIF, then restart only the private fake server", async () => {
      const isMobile = browserName === "webkit";
      const context = await browser.newContext({
        viewport: isMobile ? { width: 390, height: 844 } : { width: 1100, height: 800 },
        isMobile,
        hasTouch: isMobile,
        reducedMotion: "no-preference",
      });
      const label = `${browserName}-${isMobile ? "phone" : "desktop"}`;

      try {
        await checkSpinnerViewport(context, main, uploaded, id, label);
      } finally {
        await context.close();
      }

      await stopSpinnerServer(server);
      await startSpinnerServer(server, origin);

      return await main.call("spinner_status");
    });

  const page = await test.step("Require persisted selection before opening the restarted browser", async () => {
    expect(spinnerLibrary8.current?.id).toBe(id);

    return await browser.newPage({ reducedMotion: "no-preference" });
  });

  try {
    await checkMissingSpinner(page, main, id, url, etag, uploaded);
  } finally {
    await page.close();
  }
});

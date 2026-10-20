import { type SpinnerLibrary, type SpinnerTone } from "../src/lib/spinner";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { createTonalFixtures } from "./fixtures/spinner-tonal-images";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

type SpinnerConnection = Awaited<ReturnType<typeof spinnerClient>>;
const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

const ANIMATION_FRAMES = 15;
const MIN_CONTRAST = 0.5;

/**
Requires a persisted image-derived tone in the canonical spinner response.
@param result - Shared-library-normalized native spinner selection result.
@returns Actual tone and saved asset identity, without a repeated nullable guard.
*/
function requiredTone(result: SpinnerLibrary) {
  assert.ok(result.current?.tone);

  return { tone: result.current.tone, id: result.current.id };
}

/**
Checks all native tonal palettes and original managed bytes before capturing restart state.
@param main - Connected real main MCP client with private state.
@param directory - Private managed-asset directory.
@param fixtures - Original native tonal image paths created by the fixture producer.
@returns Canonical persisted library after all tonal selections and assertions.
*/
async function checkedTonalLibrary(
  main: SpinnerConnection,
  directory: string,
  fixtures: Awaited<ReturnType<typeof createTonalFixtures>>
) {
  const tones = new Map<string, SpinnerTone>();

  for (const name of ["dark", "bright", "subtle", "hidden", "weighted"]) {
    const result = await main.call("spinner_set", { path: fixtures[name] });

    const { tone, id } = requiredTone(result);

    assert.equal(tone.version, 1);
    assert.ok(tone.contrast >= MIN_CONTRAST);
    assert.ok(tone.contrast <= 2);
    assert.ok(Number.isFinite(tone.brightness));
    tones.set(name, tone);
    assert.deepEqual(await readFile(path.join(directory, "spinner-assets", id)), await readFile(fixtures[name]));
  }

  assert.deepEqual(tones.get("dark"), tones.get("hidden"));
  assert.notDeepEqual(tones.get("dark"), tones.get("weighted"));
  assert.notDeepEqual(tones.get("dark"), tones.get("bright"));
  assert.notDeepEqual(tones.get("bright"), tones.get("subtle"));

  return main.call("spinner_status");
}

/**
Checks that an animated native GIF selection retains both its frames and persisted tone.
@param main - Reconnected real main MCP client with the same private storage.
*/
async function assertAnimatedTone(main: SpinnerConnection) {
  const gif = await main.call("spinner_set", { path: fixture });

  assert.equal(gif.current?.frames, ANIMATION_FRAMES);
  assert.ok(gif.current.tone);
}

await test("set derives one bounded persisted tone per image from visible pixels, leaving original alpha and bytes intact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-tone-"));

  let main = await spinnerClient(directory);

  try {
    const fixtures = await createTonalFixtures(directory);
    const before = await checkedTonalLibrary(main, directory, fixtures);

    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), before);
    await assertAnimatedTone(main);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

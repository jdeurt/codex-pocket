import type { Page } from "@playwright/test";

/**
Observe the microphone stream actually connected to Web Audio, without replacing navigator's device methods.
@param page - Browser page before its application is loaded.
@param property - Test-owned global where the actual input track is retained.
*/
export async function observeMicrophone(page: Page, property: "voiceFixtureTrack" | "droppedTrack") {
  await page.addInitScript((name) => {
    const NativeContext = AudioContext;

    /**
    Observe real microphone connections while retaining native capture and playback.
    */
    class ObservedContext extends NativeContext {
      /** Record the track belonging to this source before delegating to Web Audio.
      @param stream - Actual microphone stream supplied by the application.
      @returns Native input node for this audio context.
      */
      override createMediaStreamSource(stream: MediaStream) {
        Object.defineProperty(globalThis, name, { configurable: true, value: stream.getAudioTracks()[0] });

        return super.createMediaStreamSource(stream);
      }
    }

    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: ObservedContext });
  }, property);
}

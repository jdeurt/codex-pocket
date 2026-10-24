"use client";
import { type PocketSettings, type PocketSettingsMutation, REALTIME_SETTING_LIMIT } from "@/lib/settings";
import { submitRealtimeSettings, updateInput } from "../runtime/form-events";
import { useState } from "react";

/** Edit optional provider identifiers without taking ownership of the voice transport or catalog.
@param props - Saved overrides, shared submission lock, and partial persistence callback.
@returns Realtime fields whose blank values restore Pocket’s current OpenAI recommendations for the next session.
*/
export function RealtimeSettingsFields({
  settings,
  busy,
  save,
}: {
  settings: PocketSettings;
  busy: boolean;
  save: (change: PocketSettingsMutation) => Promise<boolean>;
}) {
  const [voice, setVoice] = useState(settings.realtimeVoice ?? "");
  const [model, setModel] = useState(settings.realtimeModel ?? "");

  return (
    <section aria-labelledby="realtime-settings-heading">
      <h3 id="realtime-settings-heading">Realtime</h3>
      <p id="realtime-settings-help" className="pocket-settings-help">
        Voice and model overrides apply to the next realtime session. Leave a field blank to use Pocket’s current OpenAI
        recommendation. Availability is checked when the session starts.
      </p>
      <form onSubmit={submitRealtimeSettings.bind(undefined, save, voice, model)}>
        <label htmlFor="realtime-voice">Realtime voice</label>
        <input
          id="realtime-voice"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={voice}
          maxLength={REALTIME_SETTING_LIMIT}
          disabled={busy}
          aria-describedby="realtime-settings-help"
          onChange={updateInput.bind(undefined, setVoice)}
        />
        <label htmlFor="realtime-model">Realtime model</label>
        <input
          id="realtime-model"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={model}
          maxLength={REALTIME_SETTING_LIMIT}
          disabled={busy}
          aria-describedby="realtime-settings-help"
          onChange={updateInput.bind(undefined, setModel)}
        />
        <div className="pocket-settings-actions">
          <button type="submit" disabled={busy}>
            Save realtime settings
          </button>
        </div>
      </form>
    </section>
  );
}

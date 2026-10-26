"use client";
import "./pocket-settings.css";
import { OPENAI_API_KEY_LIMIT, type PocketSettingsMutation } from "@/lib/settings";
import { usePocketSettings } from "@/hooks/use-pocket-settings";
import { RealtimeSettingsFields } from "./realtime-settings-fields";
import { usePocketClient } from "@/providers/pocket-state";
import { useStore } from "zustand";
import { changeToolVisibility, submitKey, removeKey } from "@/runtime/settings-form";
import { updateInput } from "@/runtime/form-events";
import { useState } from "react";
import { usePocketId } from "@/providers/pocket-navigation-context";

/** Keep the visibility control responsive while persisting its global preference.
@param props - Latest saved value, shared submission lock, and durable update callback.
@returns A labeled checkbox that restores its saved value after a failed update.
*/
function ToolCallSetting({
  initial,
  busy,
  save,
}: {
  initial: boolean;
  busy: boolean;
  save: (change: PocketSettingsMutation) => Promise<boolean>;
}) {
  const [checked, setChecked] = useState(initial);

  return (
    <label className="pocket-settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={changeToolVisibility.bind(undefined, save, setChecked)}
        aria-describedby="tool-calls-help"
      />
      <span>
        Show tool calls
        <span id="tool-calls-help" className="pocket-settings-help">
          Show tool activity in the main Pocket conversation.
        </span>
      </span>
    </label>
  );
}

/** Present global Pocket preferences and a write-only OpenAI credential editor.
@returns Central settings content, with credential values confined to the password input.
*/
export function PocketSettingsPanel() {
  const pocketId = usePocketId();
  const { settings } = usePocketClient();
  const { data, error: readError } = usePocketSettings();
  const [apiKey, setApiKey] = useState("");
  const { busy, error, status } = useStore(settings.store);
  const { didSave } = settings;

  return (
    <div className="pocket-settings">
      <section aria-labelledby="usage-settings-heading">
        <h3 id="usage-settings-heading">Usage</h3>
        <a href={`/settings/usage?pocket=${encodeURIComponent(pocketId)}`}>Usage &amp; costs →</a>
        <p className="pocket-settings-help">Explore recorded costs over time, by feature and model.</p>
      </section>
      {(error || readError) && <p role="alert">{error || readError}</p>}
      <p role="status">{status || (data || readError ? "" : "Loading settings…")}</p>
      {data && (
        <>
          <section aria-labelledby="conversation-settings-heading">
            <h3 id="conversation-settings-heading">Conversation</h3>
            <ToolCallSetting key={String(data.showToolCalls)} initial={data.showToolCalls} busy={busy} save={didSave} />
          </section>
          <section aria-labelledby="openai-settings-heading">
            <h3 id="openai-settings-heading">OpenAI</h3>
            <p id="openai-key-help" className="pocket-settings-help">
              Add an OpenAI API key to enable advanced functionality, including realtime voice. The key is stored
              privately on the computer running Pocket and is never shown again here.
            </p>
            <p>
              {data.openaiApiKeyConfigured ? "API key configured" : "No API key configured"}
              {data.openaiApiKeySource === "environment" && " through the host environment"}.
            </p>
            <form onSubmit={submitKey.bind(undefined, didSave, setApiKey, apiKey)}>
              <label htmlFor="openai-api-key">OpenAI API key</label>
              <input
                id="openai-api-key"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={apiKey}
                maxLength={OPENAI_API_KEY_LIMIT}
                required
                disabled={busy}
                aria-describedby="openai-key-help"
                onChange={updateInput.bind(undefined, setApiKey)}
              />
              <div className="pocket-settings-actions">
                <button type="submit" disabled={busy || !apiKey.trim()}>
                  {data.openaiApiKeyConfigured ? "Replace API key" : "Save API key"}
                </button>
                {data.openaiApiKeySource === "saved" && (
                  <button type="button" disabled={busy} onClick={removeKey.bind(undefined, didSave, setApiKey)}>
                    Remove saved key
                  </button>
                )}
              </div>
            </form>
            <p className="pocket-settings-help">
              Removing a saved key restores the host environment key, if one is configured.
            </p>
          </section>
          <RealtimeSettingsFields
            key={JSON.stringify([data.realtimeVoice, data.realtimeModel])}
            settings={data}
            busy={busy}
            save={didSave}
          />
        </>
      )}
    </div>
  );
}

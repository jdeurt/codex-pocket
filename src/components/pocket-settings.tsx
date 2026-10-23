"use client";
import "./pocket-settings.css";
import { OPENAI_API_KEY_LIMIT, type PocketSettingsMutation } from "@/lib/settings";
import { savePocketSettings, usePocketSettings } from "@/hooks/use-pocket-settings";
import { RealtimeSettingsFields } from "./realtime-settings-fields";
import { useState } from "react";

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

  async function change(isChecked: boolean) {
    setChecked(isChecked);

    if (!(await save({ showToolCalls: isChecked }))) {
      setChecked(!isChecked);
    }
  }

  return (
    <label className="pocket-settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={(event) => void change(event.target.checked)}
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
@param props - Shared menu submission lock and lock callback preserving in-flight saves.
@returns Central settings content, with credential values confined to the password input.
*/
export function PocketSettingsPanel({
  busy,
  onBusyChange,
}: {
  busy: boolean;
  onBusyChange: (isBusy: boolean) => void;
}) {
  const { data, error: readError } = usePocketSettings();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function didSave(change: PocketSettingsMutation) {
    onBusyChange(true);
    setError("");
    setStatus("");

    try {
      await savePocketSettings(change);
      setStatus("Settings saved.");

      return true;
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Could not save Pocket settings.");

      return false;
    } finally {
      onBusyChange(false);
    }
  }

  async function saveKey(value: string | null) {
    if (await didSave({ openaiApiKey: value })) {
      setApiKey("");
    }
  }

  return (
    <div className="pocket-settings">
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
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveKey(apiKey.trim());
              }}
            >
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
                onChange={(event) => {
                  setApiKey(event.target.value);
                }}
              />
              <div className="pocket-settings-actions">
                <button type="submit" disabled={busy || !apiKey.trim()}>
                  {data.openaiApiKeyConfigured ? "Replace API key" : "Save API key"}
                </button>
                {data.openaiApiKeySource === "saved" && (
                  <button type="button" disabled={busy} onClick={() => void saveKey(null)}>
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

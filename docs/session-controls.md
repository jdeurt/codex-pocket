# Session controls

The main Pocket can inspect its session and change the model or reasoning effort through typed tools. Ask for these changes in chat; the phone header shows the effective model and effort.

| Tool                      | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `pocket_session_models`   | List Pi provider/model catalog identifiers                                     |
| `pocket_session_inspect`  | Read model, effort, active turn, connection state, and native token accounting |
| `pocket_session_settings` | Change `model`, `effort`, or both                                              |

Settings affect subsequent Pi turns. Native Codex/Claude delegate defaults and explicit child overrides are independent. Active turns and existing delegates retain their settings. Changing settings does not start, cancel, or restart a turn.

## Persistence and uncertainty

Pocket updates settings over the existing native connection, reads them back, and saves them in private `session-settings/<parent-hash>.json` per parent (legacy `session-settings.json` is read for migration). Reconnects restore only that parent's settings.

If native acceptance succeeds but readback or persistence fails, the result is uncertain. Inspect the current settings before retrying. Pocket does not automatically replay the mutation.

## What inspection can tell you

Inspection reports the execution boundary: Pi uses host process permissions and does not enforce Codex sandbox or approval settings. It also returns total and last-turn token counters when observed, subset metadata, the model context window when reported, and the last observed compaction time. Missing observations remain `null`.

Token accounting is not a measurement of current context occupancy. Exact remaining capacity and utilization remain `null`; Pocket does not infer them by subtracting cumulative usage from the context window. An unobserved historical compaction has no known timestamp.

## Implementation boundary

Only the main Pocket registers these tools. The host supplies its control origin; `/api/session` uses the same host/origin guard, and mutations require an allowed origin and JSON content type. Callers cannot select another thread, change permissions, or forward arbitrary native RPC methods.

Inspection uses `thread/read` and existing bridge observations. Mutation uses `thread/settings/update`, followed by native readback and parent-scoped persistence. Pi catalog listing uses `pocket_session_models`. Account/rate-limit controls, manual compaction, and generic terminal control are outside this interface. [Delegate steering and cancellation](side-pockets.md#agent-tools) have their own tools.

`tests/workflows/session-controls.test.ts` exercises the real bridge against an isolated protocol fixture. It checks active-turn preservation, persisted settings after a fresh bridge, and absence of turn execution or permission changes. This is offline integration evidence; authenticated native behavior requires a separate check.

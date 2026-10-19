# Phone file attachments

Use the paperclip beside Send to choose multiple images or files. Selected files appear above the composer with upload progress, retry, and remove controls. Send supports files alone or files with text. A successful queued/sent acknowledgement clears the selection; uncertain delivery preserves the same message ID for retry. The existing desktop Enter, mobile newline, Shift+Enter, and IME behavior is preserved.

The visible button is keyboard and screen reader accessible. The compact attachment strip follows familiar [mobile attachment patterns](https://screensdesign.com/explore/ui-elements/file-attachments/). It does not depend on a hidden gesture.

## Storage and delivery

- Limits: ten files per message, 25 MiB per file, 50 MiB combined, and 40 million pixels per image. Empty files are rejected.
- Uploads are streamed to private temporary directories and committed atomically beneath `CODEX_POCKET_STATE_DIR/uploads/<parent SHA-256>/<upload UUID>/`. Names are display metadata and never determine storage paths. Upload retries must match the existing name, MIME type, and SHA-256.
- The original bytes remain intact, including every frame and timing information in animated GIFs. Supported raster images are verified, oriented, and normalized to a separate PNG with a maximum edge of 2048 pixels for Codex visual input and previews. Other file types, including SVG/HTML, are downloadable files with no inline execution.
- The installed Codex CLI 0.163.0 schema, generated with `codex app-server generate-json-schema`, accepts `localImage` in `UserInput`. Its other variants include text, image, audio, localAudio, skill, and mention; it has no general localFile variant. Images use structured `localImage` inputs. Every attachment also includes a text input naming its MIME type, size, original filename, and durable absolute path to the original bytes. Codex filesystem tools and local-path tools such as custom spinner selection can read or copy that original, subject to their existing permissions. The original path ends in `original`, without a filename extension; tools should inspect file content or the supplied MIME type. The reference is not native document ingestion. Tool availability determines which formats it can interpret.
- Attachment metadata is persisted with outbox receipts and retained for saved messages. Phone display uses those receipts to hide transport-only paths and show the original text plus attachments. Queued/uncertain messages use the existing delivery rules and are never blindly replayed.
- IndexedDB stores draft bytes as ArrayBuffers with filename/type metadata, scoped to the configured parent. This supports Safari sessions that cannot persist File objects. It also preserves an outstanding message ID and text across reload. If browser storage fails, file selection reports an error; ordinary text messaging remains available.
- Removing a selection removes its draft association. It does not delete uploaded copies or any user source file. Saved-message files and unreferenced uploads currently have no automatic garbage collection.
- Download/preview endpoints resolve UUIDs only under the configured parent's directory. Downloads use octet-stream, attachment disposition, no-store, nosniff, same-origin resource policy, and a sandbox CSP. Raster previews use the existing shared ChatImage component.
- `FileAttachments` is display-only and can be used in read-only transcripts. Only the main Chat composer mounts the picker and upload hook. Child transcript views must not mount these composer controls.

## Local integration verification

```sh
NODE_ENV=development CODEX_THREAD_ID= npx playwright test -c playwright.uploads.config.ts
npm run typecheck
npm run lint
```

The Playwright configuration starts an isolated Next dev server on port 3118 with a fake Codex executable, fake parent ID, private state directory, and no real chat messages. It verifies mobile Chromium, mobile WebKit, and desktop Chromium: native/keyboard picker activation, progress, remove, upload retry/reload, file-only and text+file sends, actual harness payloads and readable bytes, animated GIF original paths/frame counts/timing, lost-ack idempotency, persisted queue reconnect, safe downloads, bounds, parent scope, filename/origin rejection, draft preservation, and IME/newline behavior. Screenshots remain local under `.local/uploads-replay/`. Device emulation does not verify a physical phone's native picker or keyboard. No CI or live Codex model is used.

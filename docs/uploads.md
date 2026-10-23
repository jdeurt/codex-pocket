# File attachments

Use the paperclip beside Send to choose images or files. You can send files alone or include a message. Before sending, the attachment strip shows upload progress and controls to retry or remove a file.

Sent files appear as rows with their name, type, and size. These rows do not have an image preview or download button. Images produced by the assistant use the separate image viewer.

## Limits and supported input

- Up to ten files per message.
- Up to 25 MiB per file and 50 MiB combined.
- Up to 40 million pixels per image.
- Empty files are rejected.

Pocket preserves the original bytes, including animated GIF frames and timing. For supported raster images, it also creates an oriented PNG with a maximum edge of 2048 pixels for Codex's visual input.

Other file types are passed as local file references with their filename, MIME type, size, and original path. This is not native document ingestion: the agent needs suitable filesystem tools and permissions to interpret the file. SVG and HTML remain files and are not executed inline.

## Drafts and delivery

Draft text and attachment bytes are saved per Pocket in browser storage. A reload can restore them, including an outstanding message ID. If storage fails, Pocket reports it rather than claiming the draft is saved; ordinary text messaging remains available.

A queued or sent acknowledgement clears the selection. Uncertain delivery retains the message's identity so it can be reconciled with history. Inspect that history before retrying work that may already have arrived.

Removing a selection removes its association with the draft. It does not delete uploaded copies or a source file on your computer. Saved uploads and unreferenced copies currently have no automatic garbage collection.

## Implementation reference

Uploads are streamed into private temporary directories, then committed atomically under `CODEX_POCKET_STATE_DIR/uploads/<parent SHA-256>/<upload UUID>/`. Display names never determine storage paths. Retries must match the original name, MIME type, and SHA-256.

The retained original has the basename `original` without an extension. Tools should inspect the content or supplied MIME type. Images use native `localImage` input; every attachment also has a text reference to its original bytes. Delivery records retain attachment metadata so the phone can show readable file rows without transport paths.

IndexedDB stores draft bytes as ArrayBuffers with filename/type metadata, allowing Safari sessions that cannot persist File objects. Retained-file endpoints enforce parent ownership and serve attachments with no-store, nosniff, same-origin resource policy, and a sandbox CSP.

Read-only Side Pocket transcripts use the display-only attachment component. Only the main chat mounts the picker and upload controls.

## Verification

```sh
npm run test:e2e -- tests/uploads/uploads.spec.ts --project=uploads-chromium --grep='pick, retry, remove'
```

The offline suites cover selection, retry, reload, file-only sends, harness payloads, original bytes, GIF preservation, uncertain acknowledgements, parent ownership, and file limits. The lean suite does not claim attachment pixel-spacing or width-matrix coverage. Physical phone picker and keyboard behavior still need device checks. See [testing](testing.md) for setup.

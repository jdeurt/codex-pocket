## Development checks

- Run only extremely focused tests during development: select the specific test cases and files that exercise the change, using a test-name filter where available. Repeat only those cases when investigating nondeterminism.
- Never run the full test suite yourself, including `npm test`, unfiltered Playwright runs, or an equivalent collection of commands. CI owns full-suite validation; inspect its results and report any outstanding failures.
- Run ESLint on the files you edit after each small batch of changes, before continuing to other files. Do not wait until the end. For example: `npx eslint path/to/changed.ts --max-warnings=0`.
- Apply lint rules and violations encountered during editing to future edits so that you do not repeat the same mistakes. Preserve unrelated lint rules; do not weaken them to make checks pass.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Error handling

- Do not use async IIFEs, including `await (async () => ...)()`, `return (async () => ...)()` or fire-and-forget variants. ESLint enforces this. Refactor function boundaries instead of hiding a block inside an immediately invoked callback.
- Collapse forwarding functions; give separate functions only to meaningful operations or independently owned lifecycles. Prefer direct Results and await over multi-statement callbacks that recreate a try block. Register test resource cleanup with the test framework when its lifetime is the test.
- Do not write `try` statements. ESLint bans `TryStatement` in JavaScript and TypeScript, including scripts and tests.
- Follow the [`try` README](https://github.com/arthurfiorette/try#usage): prefer the `t` export over `Result.try`. A local import alias is fine when `t` conflicts with a test context.
- Prefer `t(fn, ...args)` for standalone functions: it forwards arguments and retains type inference. Use `t(() => object.method(args))` when the method needs its receiver.
- For asynchronous work, use `await t(fn, ...args)` or `await t(() => operation())` to capture both synchronous invocation errors and promise rejections. `await t(existingPromise)` handles that promise, but cannot catch an error thrown before the promise is passed in.
- A single operation may use `[ok, error, value]`. For several operations, keep descriptively named Result objects and inspect `.ok` before `.value` or `.error`; avoid numbered tuple variables.
- Error handling belongs to the caller. Do not add wrappers that force every callee to return a Result, or invent a `Result.bind` abstraction. The package's `ok(value)` and `error(reason)` helpers are available when an explicit Result is needed.
- Do not use `.then()`, `.catch()` or `.finally()`, including computed-property or optional-chain variants. ESLint bans these members and enables `unicorn/prefer-await`. Use `await` and inspect `try` Results; capture the operation, perform unconditional cleanup, then propagate an unhandled failure. Do not disguise rejection handlers in another chaining helper.
- Preserve rejection propagation, early returns, cancellation and unconditional cleanup when changing error handling. Do not silently swallow errors unless an explicit fallback is intended.
- Standalone installer scripts, the unbundled service worker and browser-evaluated test fixtures must remain runnable without resolving application dependencies; use native `Promise.allSettled` at those boundaries and inspect its outcome. Application code uses the installed `try` package.

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

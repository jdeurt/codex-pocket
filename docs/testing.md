# Development and testing

Use a separate source checkout for development. The installed `~/.pocket/source` directory is managed by the updater, and accepted release directories should remain unchanged.

## Run a development checkout

Use Node.js 24 or later and install dependencies:

```sh
git clone https://github.com/jdeurt/codex-pocket.git
cd codex-pocket
npm ci
```

For a working chat, sign in to a local Codex installation and configure a disposable development conversation:

```sh
export CODEX_POCKET_STATE_DIR="$PWD/.local/dev-state"
export CODEX_POCKET_LOG_DIR="$PWD/.local/dev-logs"
export CODEX_CWD="$PWD"
export POCKET_THREAD_ID=''
npm run setup
```

Setup writes this checkout's `.env.local` and makes a real welcome call in the new conversation. Add `http://localhost:3001` and `http://127.0.0.1:3001` to that file's `CODEX_ALLOWED_ORIGINS`, then start the app in the same shell:

```sh
npm run dev -- --port 3001
```

Open `http://localhost:3001`. Port 3001 keeps development separate from the installed service on 3000. Keep the state/log exports set whenever you start this checkout; otherwise it uses the default Pocket data directory. You can also save their absolute paths in this checkout's `.env.local`.

Use a disposable working folder instead of `CODEX_CWD="$PWD"` if the development agent should not edit this checkout.

The offline test suites below do not need this chat setup or native sign-in.

## Local checks

Follow [AGENTS.md](../AGENTS.md): select an exact file and case during development, lint edited files after each batch, and leave complete suites to CI. The [behavior coverage map](test-suite.md) records source guidance, removed tests, replacement guarantees and verification limits.

```sh
node --import tsx scripts/test-flows.ts tests/workflows/pi.test.ts --test-name-pattern='Pi executes requested file'
npx eslint tests/workflows/pi.test.ts --max-warnings=0
npx prettier --check tests/workflows/pi.test.ts
```

The integration runner recursively discovers `tests/**/*.test.ts`, rejects unknown selections and runs without inherited credentials or native executables. Real application workflows use disposable state and explicit external protocol fixtures. Do not replace internal application components with mocks or add unit, source-text, constant or file-inventory tests.

CI runs `npm run check`, `npm test`, the offline browser collection and the realtime collection. The macOS job also exercises installed commands, bootstrap and the native menu-bar window. These complete-suite commands are for CI, not agent development.

## Offline browser tests

Install browser distributions once:

```sh
npx playwright install chromium webkit
```

Select one file, project and case:

```sh
npm run test:e2e -- tests/browser/workflows/transcript.spec.ts --project=pockets-chromium --grep='saved native history'
npm run test:e2e:realtime -- tests/browser/workflows/voice.spec.ts --project=realtime-chromium --grep='configured OpenAI voice hands'
```

The default projects are `pockets-chromium`, `pockets-webkit`, `agents-chromium`, `agents-webkit`, `uploads-chromium`, `uploads-webkit` and `uploads-api`. Realtime uses `realtime-chromium`, `realtime-webkit` and `realtime-api`. Desktop Chromium and phone WebKit cover materially different browser environments without repeating every viewport combination. Realtime uses phone profiles with actual browser microphone/audio APIs and synthetic provider audio.

Discovery starts no servers and runs no cases:

```sh
npm run test:e2e -- --list
npm run test:e2e:realtime -- --list
```

Each worker starts only its required Next/native/provider fixture, waits for `/api/version`, then tears it down and removes runtime state. Occupied ports fail. Projects have separate build directories under `.next/test-<project>`; server state lives under fixture-owned `.local` directories and is reset between projects. Keep `workers: 1` while these fixture origins are fixed. Traces and server diagnostics go to `test-results/`; neither runtime state nor results belong in caches.

The `test:agents`, `test:e2e:uploads`, `test:e2e:copy`, `test:e2e:virtualization` and `test:e2e:restart` aliases select their current workflow collections. Agents must still add exact case/project filters. Attachment spacing, spinner pixels and synthetic viewport matrices have no collection aliases; their deliberate retirement is recorded in the coverage map.

## CI caches

Inspection of base-commit [Check run 40020174377, attempt 1](https://github.com/jdeurt/codex-pocket/actions/runs/40020174377/attempts/1) showed package installs around 33–53 seconds, browser installation around 37 seconds and the realtime collection around four minutes. These are historical bottleneck measurements; the replacement's CI duration has not been measured. The smaller workflow collection reduces repeated browser work.

The local composite action disables setup-node's automatic package-manager cache, then caches npm's `_cacache` content store and Playwright's browser distributions. Keys include OS, architecture, exact runtime/tool versions and the dependency lockfile. Fallbacks retain compatible tool versions while allowing npm integrity checks and browser revision checks to repair missing downloads. Every job runs `npm ci --include=dev --prefer-offline`; browser jobs always install system libraries and ensure required browser revisions are present. No dependencies installed by another job, profiles, private runtime state, compiler output or test results are reused.

## Production updates and live checks

`npm run test:e2e:updates` remains separate: it builds two production versions and checks asset adoption, rollback, draft/file preservation and pending work. It is not part of the default dev-server collection.

Live checks require installed, signed-in native tooling and disposable conversations:

```sh
npm run test:simulators:native
npm run test:e2e:live
```

The queue/questions/schedules/images/activity live aliases require explicit `POCKET_LIVE_TESTS=1`. `test:recovery`, `test:instructions`, `test:harnesses` and `test:delegation` remain opt-in native checks. Offline passing results do not establish live compatibility or real microphone/phone delivery. Physical iPhone keyboard, file picker, notifications and audio require actual-device checks.

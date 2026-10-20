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

```sh
npm run check
npm test
npm run build
```

`check` runs Prettier, zero-warning ESLint, and strict TypeScript checks. `npm test` runs the server/workflow suite with an empty PATH, disposable home, disabled native executable paths, and no inherited credentials. It uses the production adapters with deterministic protocol simulators. See [simulator coverage and limits](simulators.md).

```sh
npm run review:duplicates
npm run review:dead-code
```

The committed `.jscpd.json` sets similarity to `0.7`, normalizes identifiers/literals/annotations, allows two gap lines, and compares JavaScript and TypeScript. Reports go to ignored `.local/review/jscpd`. Review findings against callers and behavior before removing or combining code; generated files and dependencies are excluded.

## Offline browser tests

Install the browser engines once, then run Playwright:

```sh
npx playwright install chromium webkit
CODEX_THREAD_ID= npm run test:e2e
```

The root `playwright.config.ts` selects offline fixture projects by default. List them without starting servers:

```sh
CODEX_THREAD_ID= npm run test:e2e -- --list
```

Choose a focused suite with these npm scripts; add Playwright filters after `--`:

| Script                    | Coverage                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `test:agents`             | Agent history and replay                                    |
| `test:e2e:copy`           | Copy controls                                               |
| `test:e2e:focused`        | Focus and composer behavior                                 |
| `test:e2e:virtualization` | Transcript scrolling, status geometry, reports, and loading |
| `test:e2e:restart`        | Browser reconnect and recovery                              |
| `test:e2e:uploads`        | Attachment delivery and stored bytes                        |
| `test:e2e:attachments`    | Attachment layout                                           |
| `test:e2e:spinner`        | Spinner selection and persistence                           |

Named Pocket flows run in the default collection. Select them with `npm run test:e2e -- --project='pockets-*'`.

The root configuration uses four isolated fixture servers:

| Fixture                 | Port | Data source                                 |
| ----------------------- | ---- | ------------------------------------------- |
| Browser-local snapshots | 3101 | Model executable disabled                   |
| Saved agent replay      | 3107 | Agent JSON-RPC and synthetic Claude history |
| Upload replay           | 3118 | Upload JSON-RPC and original-byte records   |
| Named Pockets           | 3467 | Offline Codex simulator processes           |

Servers reject occupied ports rather than reusing an existing service. Each fixture has its own state and Next output directory. Spinner tests manage their own restart lifecycle. Fixture code lives under `tests/fixtures`; disposable state, screenshots, and other outputs live under `.local`.

### Production update tests

```sh
npm run test:e2e:updates
```

This suite uses `playwright.update.config.ts`. It builds two production versions and serves an isolated fixture on port 3191. Chromium and WebKit flows cover automatic upgrades and rollback, draft/attachment preservation, pending work, and reconnection. It is separate from the default dev-server fixtures because it needs actual build identities and asset replacement.

### Measure layout

Use Playwright bounding boxes and computed styles for alignment, gaps, widths, overflow, and touch targets. Check transitions as well as screenshots: empty and active status rows, streaming messages, report expansion, keyboard resize, and reconnect. The [transcript layout reference](transcript-layout.md) lists the expected measurements and test files.

Device emulation cannot verify a physical iPhone's keyboard, file picker, or notification delivery. Report those limits separately from browser results.

## Live checks

Live checks require installed, signed-in native tooling and make real model calls. Keep them separate from offline checks and production conversations.

```sh
npm run test:simulators:native
npm run build
npm run test:e2e:live
```

`test:e2e:live` enables `POCKET_LIVE_TESTS=1`, uses a new integration-test thread, and archives it afterward. Live mode replaces the offline server list. The queue, questions, schedules, images, and activity aliases also select this project but require the flag from the caller, for example:

```sh
POCKET_LIVE_TESTS=1 npm run test:e2e:queue
```

| Script              | Purpose                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `test:recovery`     | Hidden recovery inputs, resumed history, and interrupted-work recovery in a separate Codex chat |
| `test:instructions` | Native instruction-loading checks                                                               |
| `test:harnesses`    | Real Codex/Claude access, resume, history, and tool availability                                |
| `test:delegation`   | A real parent exchanging work and answers with both harnesses, closing and resuming children    |

These checks need their relevant native logins and use separate test state. A passing offline test does not establish live provider behavior. Run the relevant native calibration when changing a protocol model, and use the actual phone for device-specific checks.

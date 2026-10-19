# Pocket

A small phone interface for one Codex thread running on your computer. Messages stream live. Tool activity appears as **Thinking**. Codex can ask questions and request approvals in the conversation.

Built with Next.js, Tailwind CSS and shadcn/ui. Session selection and behavior belong to the computer; the phone has a conversation and a send button.

## Run on your computer

Use Node.js 24, npm, and a signed-in Codex CLI with app-server support. The bridge was checked against `codex-cli 0.163.0-alpha.10.2`.

```sh
npm ci
cp .env.example .env.local
```

Set `CODEX_THREAD_ID` to an existing local thread ID and `CODEX_CWD` to its absolute project directory. `codex resume` helps you find a saved thread. Set `CODEX_BINARY` to the full executable path if Codex is not on your PATH.

```sh
npm run build
npm start
```

Open <http://localhost:3000>. For development, use `npm run dev`. Restart the server after changing environment variables.

## Use your phone through Tailscale

Run this on the computer with Tailscale installed and signed in:

```sh
tailscale serve --bg http://127.0.0.1:3000
```

Add the HTTPS origin printed by Tailscale to `CODEX_ALLOWED_ORIGINS`, then restart Pocket. Keep the local origins if you use them:

```dotenv
CODEX_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://your-computer.your-tailnet.ts.net
```

Connect your phone to the same tailnet, open that HTTPS URL and add it to your home screen. Tailscale Serve supplies HTTPS and tailnet access; configure your tailnet ACLs for the people allowed to operate Codex. The app listens on loopback and checks request hosts and mutation origins. It has no separate account system. Use Serve, rather than public Funnel, for this setup.

## Environment variables

| Variable                    | Purpose                                                   | Default                                |
| --------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `CODEX_THREAD_ID`           | The one saved thread to resume                            | Required                               |
| `CODEX_CWD`                 | Absolute working directory of the host process            | Repository directory                   |
| `CODEX_BINARY`              | Local Codex executable                                    | `codex`                                |
| `CODEX_ACTIVE_MESSAGE_MODE` | Send during a turn: `steer` or `queue`                    | `steer`                                |
| `CODEX_ALLOWED_ORIGINS`     | Comma-separated allowed origins, without trailing slashes | Localhost and loopback on port 3000    |
| `CODEX_SERVER_ARGS`         | JSON array of arguments passed directly to Codex          | `["app-server","--listen","stdio://"]` |
| `CODEX_POCKET_STATE_DIR`    | Local delivery receipts and pending desktop requests      | `.local`                               |

Codex uses its local login and configuration. The bridge sends no model, sandbox, permission or approval-policy overrides. Edit those settings on the computer.

The default transport owns a local `codex app-server` process. It resumes the saved thread when connecting and restarts that process after a disconnect. It cannot steer an unrelated CLI process already running elsewhere. Use this bridge as the thread's active owner. Codex builds that provide a shared daemon can use `CODEX_SERVER_ARGS='["app-server","proxy"]'`; that requires a daemon started separately, and only rejoins threads hosted by that daemon.

Queue mode persists pending sends across bridge restarts. Delivery receipts deduplicate repeated message IDs. If the process dies before acknowledging a send, its delivery becomes uncertain and the bridge leaves it for inspection in `.local/outbox.json`; it does not replay that message automatically. Check the Codex thread before resolving the local outbox.

Questions, command approvals, file approvals and permission requests are supported on the phone. An unfamiliar request stays pending and asks you to handle it on the computer. To inspect and answer one using the exact app-server response format:

```sh
npm run desktop -- requests
npm run desktop -- respond REQUEST_ID '{"decision":"decline"}'
```

Keep `.env.local` and `.local/` private. The service worker caches the offline page only; conversation history and requests always come from the computer. Drafts stay in browser storage. Phone suspension disconnects the view while Codex continues on the computer; reopening the app restores the conversation.

## Checks

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:e2e:queue
npm run test:e2e:questions
```

`npm run lint` runs ESLint with **`--max-warnings=0`**. ESLint and Prettier use the configs and pinned dependencies bundled with `jdeurt-engineering` 1.2.0. Their source lives in `tooling/engineering/`; the `.mjs` ESLint file is compiled from the bundled TypeScript source. Generated shadcn components and bundled tooling are excluded from application lint; Prettier checks the component source. The application uses the shared non-type-aware ESLint rules together with a separate strict TypeScript check. The two overrides preserve Node's event API and protocol/React `null` values.

Build first with `npm run build`. Browser tests use the real installed Codex process, make model calls in a new integration-test thread, and archive that thread afterward. They use port 3101 and a separate ignored state directory. Install Playwright's Chromium once with `npx playwright install chromium` if it is unavailable.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [shadcn chat components](https://ui.shadcn.com/docs/components/base/message-scroller), [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

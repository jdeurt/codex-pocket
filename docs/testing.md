# Browser integration tests

`playwright.config.ts` is the single browser-test entry point. Named projects select the fixture and browser profile. Shared phone, desktop and server defaults live in `tests/fixtures/browser-defaults.ts`.

List the default offline collection without starting servers:

```sh
CODEX_THREAD_ID= npm run test:e2e -- --list
```

Select a suite with `npm run test:agents`, `test:e2e:copy`, `test:e2e:focused`, `test:e2e:virtualization`, `test:e2e:restart`, `test:e2e:uploads`, `test:e2e:attachments` or `test:e2e:spinner`. Additional Playwright filters follow `--`.

The offline configuration starts three fixture servers. They use separate private state and protocols:

| Fixture                 | Port | Protocol                                    | Next output          |
| ----------------------- | ---- | ------------------------------------------- | -------------------- |
| Browser-local snapshots | 3101 | Model executable disabled                   | `.next/test-browser` |
| Saved agent replay      | 3107 | Agent JSON-RPC and synthetic Claude history | `.next/test-agents`  |
| Upload replay           | 3118 | Upload JSON-RPC and original-byte records   | `.next/test-uploads` |

Each server rejects an occupied port. Existing servers are never reused. `tests/fixtures/next-server.ts` owns startup, shutdown signal forwarding and generated TypeScript config cleanup. Next's `distDir` and `typescript.tsconfigPath` options separate build locks and type generation. The tracked root tsconfig stays unchanged during a run.

Spinner tests retain their own restart lifecycle. Chromium uses `.next/test-spinner`; the standalone WebKit fixture has its own project and build directory.

The live collection contains the real-model flows from `live.spec.ts` and `image-delivery.spec.ts`. It is absent from the default configuration. `npm run test:e2e:live` explicitly enables it with `POCKET_LIVE_TESTS=1`. The queue, questions, schedules, images and activity aliases also select this live project. They require `POCKET_LIVE_TESTS=1` from the caller. Live mode replaces the offline server list and requires the normal local production build.

Fixture state and screenshots are disposable data under `.local`. Persistent fixture code belongs under tracked `tests/fixtures`; `.local` has no lint exemption.

The configuration uses Playwright's documented [projects](https://playwright.dev/docs/test-projects) and [web server lifecycle](https://playwright.dev/docs/test-webserver) APIs.

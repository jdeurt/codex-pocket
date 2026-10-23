# Native harness simulators

The simulators let Pocket test its native integrations without installing or signing in to Codex or Claude Code. They reproduce protocol behavior with deterministic data; real-instance calibration checks selected behaviors against the installed tools.

`npm test` runs the offline integration flows with an empty `PATH`, a disposable home, explicit nonexistent native executable settings, and no inherited credentials. Node and the TypeScript loader are addressed by absolute path. `scripts/test-flows.ts` discovers the retained integration files; `--simulators` selects the Pi, conversation, Side Pocket and Claude-history application workflows. Isolated tests of the simulator classes themselves are excluded from the suite.

```sh
npm test                      # Complete offline integration suite; CI only for agents
npm run test:simulators        # Simulator integration flows only
npm run test:simulators:native # Explicit authenticated native calibration
npm run simulators:extract     # Refresh contracts from installed implementations
```

The last two commands require installed native tooling; ordinary tests do not. Calibration creates an ephemeral Codex thread and a nonpersistent Claude session in a disposable working directory. It makes real inference calls. It writes only versions and passing behavior names to `.local/simulator-calibration.json`, then closes both processes. It does not select another main Pocket, restart production, or inspect an existing conversation.

For focused development, pass an exact integration file and case to the isolated runner:

```sh
node --import tsx scripts/test-flows.ts tests/workflows/conversation.test.ts --test-name-pattern='Codex delivery retains'
```

## Interface snapshots

`tests/simulators/contracts/codex.json` contains the installed CLI's complete combined app-server schema, generated with `--experimental`. The snapshot includes 172 client methods, 11 server requests, one client notification, and 85 server notifications. All generated v2 response and value definitions are retained. Requests, responses, notifications, and host answers to server requests are validated against those definitions without coercion.

Parameterless and nullable requests have explicit response mappings. The installed generator omits a response schema for `config/mcpServer/reload`; a separate native probe confirmed its empty-object receipt. That exception is documented in the contract validator and calibration record.

`tests/simulators/contracts/claude.json` preserves all seven installed declaration files, including referenced private declarations, package exports, declaration hashes, SDK tools, browser and bridge interfaces, and all 30 `Query` members. The package is pinned by Pocket's lockfile; referenced third-party types remain supplied by those dependencies. This is an interface snapshot, not a copied Claude runtime.

The snapshots are tied to **Codex CLI 0.163.0-alpha.10.2** and **Claude Agent SDK 0.3.303**. Native Claude calibration used **Claude Code 2.1.292**, which differs from the SDK package's declared CLI version, 2.1.303. Do not infer that later SDK methods work on that older CLI. See [snapshot provenance](../tests/simulators/contracts/provenance.json) and [calibration evidence](../tests/simulators/contracts/calibration.json).

Sources: [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), the installed CLI schema generator, and the installed `@anthropic-ai/claude-agent-sdk` declarations. Regeneration reads the installed versions; review version and declaration changes before replacing the snapshots.

## Behavior models and scenarios

The snapshots cover the installed interfaces; built-in behavior is limited to the models below. Other operations need explicit scenarios and otherwise fail with `SIMULATOR_UNIMPLEMENTED`. Full semantic parity with native implementations is not claimed.

| Backend               | Built-in behavior                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex session/history | Initialization; start, resume, fork, read, list, loaded-list, turn pagination, names, model/effort, archive/unarchive, unsubscribe and delete. Saved threads and archive state survive process replacement through an explicit test-state file.                                                         |
| Codex turns           | One active turn, conditional steering, interruption, literal output chunks, optional usage events, scripted failure, bidirectional server requests, schema-checked host answers and duplicate-answer rejection.                                                                                         |
| Codex filesystem      | Seven `fs/*` operations over an in-memory POSIX tree: create directory, write, read, copy, metadata, directory listing and removal. These never touch the host filesystem. The virtual tree is connection-local.                                                                                        |
| Codex other methods   | Ordered request scenarios with exact optional parameter matching, validated results, native errors, before/after notifications, delay and disconnect injection. These cover the complete extracted method surface without pretending to implement external services.                                    |
| Claude streaming      | Actual SDK initialization and control envelopes, model/permission changes, initialization catalogs, literal assistant/result messages, held turns, interruption, queued user input, and host permission/hook/dialog replies.                                                                            |
| Claude controls       | Local deterministic model/settings/MCP catalogs plus explicit control-response scenarios for other operations. SDK APIs that operate locally continue to use the real installed JavaScript SDK. Browser/bridge network services are described by the snapshots but are not recreated as local services. |

These are deterministic protocol simulators, not model emulators. They do not reason, execute shell tools, reproduce native tokenization, authenticate, contact MCP services, or predict remote billing/rate limits. Generated Claude usage and costs are explicitly zero. Use supplied native-shaped events when a test needs particular accounting, task, approval, or error data.

Application tests launch `tests/simulators/cli.ts` through Node or host it behind a real socket; they assert Pocket workflow outcomes rather than simulator behavior. `simulatorConfig()` returns a production `CodexRpc` configuration. `preparedClaude()` writes a fixture before launching the actual SDK against the Node backend with an isolated environment.

A CLI scenario is a JSON file selected by `POCKET_SIMULATOR_SCENARIO`:

```json
{
  "turn": {
    "chunks": ["First ", "second"],
    "hold": false
  },
  "scripts": [
    {
      "method": "account/read",
      "result": { "account": null, "requiresOpenaiAuth": true }
    }
  ],
  "claude": {
    "text": "Deterministic reply",
    "requests": [
      {
        "subtype": "can_use_tool",
        "tool_name": "Bash",
        "input": { "command": "fixture only; never executed" },
        "tool_use_id": "test-tool"
      }
    ]
  }
}
```

Set `POCKET_SIMULATOR_HARNESS=claude` for Claude's wire protocol. Otherwise the CLI speaks Codex JSON-RPC. `POCKET_SIMULATOR_STATE` optionally names an isolated Codex state file. Never point it at a real native store. Stateful defaults are intentionally limited: they do not reproduce all filtering, permission-policy, queueing, storage, transport or platform semantics of the native applications. Add a calibrated scenario or extend the state model when a test needs those details.

## Evidence and maintenance

The opt-in calibration command retains separate native probes; the replacement offline suite exercises Pocket workflows rather than dependency conformance. The committed October 20 calibration records cover native initialization, Codex ephemeral-history rejection, model/effort readback, idle steer/interrupt rejection, streamed completion, seven filesystem operations, and Claude initialization/model catalogs, idle interrupt receipt, empty MCP catalog, model/permission mutation and streamed completion.

The current offline flows cover durable receipts and reconnects, questions and ordered steering, interruption and recovery, Side Pocket delivery, native history migration, read-only browser histories and private settings. Simulator filesystem, fork/archive, SDK callback and accounting permutations were retired. See the [behavior map](test-suite.md) for the replacement guarantees and the known failing Pi live-ingestion regression. Neither offline replay nor the historical calibration establishes current live compatibility.

When adding behavior, retain the full interface snapshots, add a whole-flow scenario, and run the relevant assertions against a disposable real session. Keep native calibration opt-in. Do not turn an unknown operation into an empty successful response to make a test pass.

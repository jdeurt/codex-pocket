# Usage reports

## Settings dashboard

Open **Settings → Usage & costs** to see recorded usage across all Pockets on this computer. The D3 stacked bar chart groups daily known costs by feature or model. Choose the last 7, 30 or 90 calendar days, or a custom interval of up to 366 days. Feature and qualified provider/model filters apply to the chart, totals and contribution table together. Dates use the browser's timezone; custom end dates are inclusive. Refresh reads local accounting without calling a model.

Pocket retains content-free observations in the private `costs.sqlite` ledger under its configured state directory. SQLite upserts use stable native entry/request identities; reopening a Pi session does not count its source usage twice. Each actual Decisions HTTP attempt gets a new identity before dispatch, so an aborted or failed attempt without returned usage remains visible as unknown. Concurrent Pocket processes share the ledger safely. The guarded, non-cacheable `/api/costs` endpoint exposes aggregates, never prompts, outputs, credentials or source paths.

Recorded features include:

- Main agent: native Pi assistant usage, including errors and interrupted requests when the SDK exposes accounting.
- Context & compaction: native compaction, branch-summary and usage entries, including cache warming when exposed. Aggregate native summary usage may represent multiple internal calls.
- Task membership and task completion: separate feature identities, actual returned token counts and dated Decisions-specific estimates. Decisions output tokens are free; cache reads and writes are subsets of total input. The initial standard estimate assumes 30-minute cache writes.
- Live voice: the final provider `usage.seconds`, counted once per application-owned call, with backend work accounted separately.
- Side Pockets: incremental managed Codex notifications and Claude assistant-request usage. Unknown model rates remain unknown. Unrelated local native conversations are not scanned.

Known dollars combine estimates and any reported amounts, displayed separately. Unknown costs are excluded from dollar totals and counted explicitly, rather than treated as free. Token estimates from native SDK catalogs are API-equivalent estimates, not invoices or subscription consumption. Pricing provenance is saved with each observation; streaming updates replace the same request rather than adding a new charge. Service tiers, regional and long-context premiums, discounts, separately billed tools and unexposed SDK accounting can change the actual bill. Recorded token and time totals are partial when providers do not return accounting.

Reopening an existing Pi conversation imports accounting in its immutable native records. Older classifier, voice and delegate calls are not reconstructed. Running or interrupted calls can lack final usage permanently. Tracking is observational and does not enforce a spending limit.

Decisions and voice rate sources: [Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability), [model and cache pricing](https://developers.openai.com/api/docs/pricing), and [GPT-Live per-second billing](https://developers.openai.com/api/docs/models/gpt-live-1), checked October 26, 2026 UTC.

## CLI reports

Run these commands from a source checkout after `npm ci`, using Node.js 24. They read local Codex and Claude Code records; they are developer scripts, not `pocket` CLI subcommands. Choose an explicit interval or a local calendar day and IANA timezone:

```sh
npm run usage -- --day 2026-10-20 --timezone America/Los_Angeles
npm run usage -- --start 2026-10-20T00:00:00-07:00 --end 2026-10-21T00:00:00-07:00 --timezone America/Los_Angeles --format markdown
```

## Coverage

The default roots are `$CODEX_HOME/sessions` (or `~/.codex/sessions`) and `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`). Override them with `--codex-dir` and `--claude-dir`. JSON includes per-chat/per-model and ancestry-grouped totals, original token categories, source paths, subset relationships, deduplicated records and missing-coverage notes. Repeated cumulative Codex counters, resumed file copies, inherited fork history and repeated Claude requests are deduplicated. Cloud work appears only when its native records are available locally.

## Cost estimates

Billed charges and subscription consumption remain unknown. Native reported USD is retained separately. To compute an explicitly labeled token-price estimate, pass `--prices prices.json` containing records like this (replace the illustrative rates and source with dated pricing you intend to use):

```json
[
  {
    "harness": "codex",
    "model": "your-model",
    "currency": "USD",
    "source": "Your dated pricing source",
    "date": "2026-10-20",
    "serviceTier": null,
    "perMillion": {
      "uncached_input_tokens": 1,
      "cached_input_tokens": 0.5,
      "output_tokens": 2
    }
  }
]
```

A missing rate for a used category leaves that estimate unknown. Claude pricing can also include `cache_creation_input_tokens`. Cached/reasoning subset counters are never added twice. Running sessions and incomplete or missing logs can leave the report incomplete.

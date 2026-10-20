# Usage reports

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

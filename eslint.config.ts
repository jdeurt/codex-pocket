import { createConfig } from "./tooling/engineering/eslint.config.mjs";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [
      ".next/**",
      ".local/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "tooling/engineering/**",
      "src/components/ui/**",
      "src/hooks/use-highlighted-code.ts",
      "src/lib/highlighter.tsx",
    ],
  },
  ...createConfig(),
  {
    files: ["src/server/**"],
    // Node streams and this bridge use the Node event API, including error and exit events.
    rules: { "unicorn/prefer-event-target": "off" },
  },
  {
    files: ["src/**"],
    // JSON-RPC and React APIs both use null as a meaningful wire or UI value.
    rules: { "unicorn/no-null": "off" },
  },
]);

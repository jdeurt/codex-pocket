import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";

const buildVersion = process.env.POCKET_BUILD_VERSION ?? randomUUID();

const nextConfig: NextConfig = {
  // Compile the same release identity into the client and server, including local builds.
  env: { NEXT_PUBLIC_POCKET_BUILD_VERSION: buildVersion },
  distDir: process.env.POCKET_TEST_DIST_DIR ?? ".next",
  typescript: { tsconfigPath: process.env.POCKET_TEST_TSCONFIG ?? "tsconfig.json" },
  cacheComponents: false,
  partialPrefetching: false,
  serverExternalPackages: ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

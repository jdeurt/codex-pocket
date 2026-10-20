import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
  config options here
  */
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

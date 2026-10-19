import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
  config options here
  */
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

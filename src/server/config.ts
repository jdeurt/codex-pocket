import { z } from "zod";

export const configSchema = z
  .object({
    threadId: z.string().min(1),
    cwd: z.string().refine((s) => s.startsWith("/"), "cwd must be an absolute path"),
    codexBinary: z.string().min(1).default("codex"),
    serverArgs: z.array(z.string()).default(["app-server", "--listen", "stdio://"]),
    activeMessageMode: z.enum(["steer", "queue"]).default("steer"),
    allowedOrigins: z
      .array(z.url().refine((s) => new URL(s).origin === s, "Use an origin without a trailing slash or path"))
      .min(1)
      .default(["http://localhost:3000", "http://127.0.0.1:3000"]),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

/**
Parse the attached process environment with the strict Pocket configuration schema.
@returns Validated parent identity, native process arguments and allowed origins.
*/
async function configuredEnvironment(): Promise<Config> {
  const serverArgs: unknown = JSON.parse(process.env.CODEX_SERVER_ARGS ?? '["app-server","--listen","stdio://"]');

  return configSchema.parseAsync({
    threadId: process.env.CODEX_THREAD_ID,
    cwd: process.env.CODEX_CWD ?? process.cwd(),
    codexBinary: process.env.CODEX_BINARY ?? "codex",
    serverArgs,
    activeMessageMode: process.env.CODEX_ACTIVE_MESSAGE_MODE ?? "steer",
    allowedOrigins: (process.env.CODEX_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
      .split(",")
      .map((s) => s.trim()),
  });
}

/**
Validate configuration only when this process is explicitly attached to a conversation.
@returns The normalized environment configuration, or null for an unconfigured process.
*/
export async function readConfig(): Promise<Config | null> {
  return process.env.CODEX_THREAD_ID ? configuredEnvironment() : null;
}

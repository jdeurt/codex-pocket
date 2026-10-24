/** Prefer an explicitly configured loopback endpoint for native MCP clients.
@param origins - Ordered allowed origins.
@returns First loopback origin, falling back to the configured first origin.
*/
export function localOrigin(origins: string[]) {
  for (const origin of origins) {
    if (["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) {
      return origin;
    }
  }

  return origins[0];
}

/** Encode explicit Codex overrides without reading process configuration.
@param overrides - Native configuration values.
@returns Ordered CLI override arguments.
*/
export function codexOverrides(overrides: Record<string, unknown>) {
  const args: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    args.push("-c", `${key}=${JSON.stringify(value)}`);
  }

  return args;
}

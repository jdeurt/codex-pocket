import type { Instrumentation } from "next";

export async function register() {
  // Next uses this positive runtime branch to exclude Node imports from Edge bundles.
  // eslint-disable-next-line unicorn/prefer-early-return
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./server/register");
    registerNode();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // eslint-disable-next-line unicorn/prefer-early-return
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { log } = await import("./server/logging");
    log().error({ error, request, context }, "server.request_error");
  }
};

import { type Instrumentation } from "next";

export async function register() {
  // Load the host integrations only in Next's Node runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { registerNode } = await import("./server/register");
  registerNode();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { log } = await import("./server/logging");
  log().error({ error, request, context }, "server.request_error");
};

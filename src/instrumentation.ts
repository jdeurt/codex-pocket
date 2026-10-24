import { type Instrumentation } from "next";

/**
Registers native host integrations once for each Next Node server instance.
@returns Completion of native registration; other Next runtimes perform no host access.
*/
export async function register() {
  const native = process.env.NEXT_RUNTIME === "nodejs" ? await import("./server/register") : undefined;

  void native?.registerNode();
}

/**
Records Next server errors with the original request and rendering context.
@param error - Native error captured by Next's request lifecycle.
@param request - Request metadata supplied by Next.
@param context - Next route and rendering context for the failure.
@returns Completion of logging in Node; other runtimes do not load native integrations.
*/
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const native = process.env.NEXT_RUNTIME === "nodejs" ? await import("./server/logging") : undefined;

  native?.log().error({ error, request, context }, "server.request_error");
};

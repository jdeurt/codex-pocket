import { type ZodType } from "zod";
import { createResourceStore } from "../state/resource";
import { subscribeResource } from "./resource-subscription";

/** Share one resource subscription among consumers in a single application scope.
@param url - Explicitly scoped API URL.
@param schema - Boundary validation for every network response.
@param initial - Optional serialized server data.
@returns Resource state and reference-counted lifecycle operations.
*/
export function createResource<T>(url: string, schema: ZodType<T>, initial?: T) {
  const store = createResourceStore(initial);

  let users = 0;
  let stop: (() => void) | undefined;

  return {
    store,
    retain: () => {
      users++;
      stop ??= subscribeResource(url, schema, store);

      return () => {
        users--;

        if (users !== 0) {
          return;
        }

        stop?.();
        stop = undefined;
      };
    },
    refresh: () => {
      if (!(users > 0)) {
        return;
      }

      stop?.();
      stop = subscribeResource(url, schema, store);
    },
  };
}

/** Cache resource owners only within this request/client instance, never in module globals.
@param scope - Builds URLs for one selected Pocket.
@param initial - Server-hydrated resource values indexed by their unscoped endpoint.
@returns Typed resource lookup and explicit invalidation for successful mutations.
*/
export function createResources(scope: (url: string) => string, initial: Record<string, unknown> = {}) {
  const entries = new Map<string, ReturnType<typeof createResource<unknown>>>();

  return {
    read: <T>(url: string, schema: ZodType<T>) => {
      let resource = entries.get(url);

      if (!resource) {
        const data = initial[url] === undefined ? undefined : schema.parse(initial[url]);

        resource = createResource<unknown>(scope(url), schema, data);
        entries.set(url, resource);
      }

      return resource;
    },
    refresh: (url: string) => entries.get(url)?.refresh(),
  };
}

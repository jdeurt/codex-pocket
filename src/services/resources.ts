import { resourceState } from "../state/resource";
import { type ZodType } from "zod";
import { observable } from "../runtime/stores";
import { subscribeResource } from "./resource-subscription";

/**
Runtime owner of one reference-counted network subscription.
*/
class Resource<T> {
  private users = 0;
  private stop: (() => void) | undefined;

  /**
  Release one mounted consumer and stop the last subscription.
  */
  private release = () => {
    this.users--;

    if (this.users !== 0) {
      return;
    }

    this.stop?.();
    this.stop = undefined;
  };

  readonly store;

  /** Start network effects for the first consumer.
  @returns Cleanup for one retained consumer.
  */
  retain = () => {
    this.users++;
    this.stop ??= subscribeResource(this.url, this.schema, this.store);

    return this.release;
  };

  /**
  Refresh an actively observed resource without clearing its last good value.
  */
  refresh = () => {
    if (!(this.users > 0)) {
      return;
    }

    this.stop?.();
    this.stop = subscribeResource(this.url, this.schema, this.store);
  };

  /** Allocate isolated observable state without fetching.
  @param url - Scoped network endpoint.
  @param schema - Response validator.
  @param initial - Optional server bootstrap data.
  */
  constructor(
    private readonly url: string,
    readonly schema: ZodType<T>,
    initial?: T
  ) {
    this.store = observable(resourceState(initial));
  }
}

/** Verify the schema that created this resource before exposing its typed store.
@param resource - Runtime entry whose data was validated by its construction schema.
@param schema - Exact schema requested by this consumer.
@returns Whether the resource's stored data has the requested validated type.
*/
function hasResourceSchema<T>(resource: Resource<unknown>, schema: ZodType<T>): resource is Resource<T> {
  return resource.schema === schema;
}

/**
Runtime owner of resource identity and subscription lifetime for one Pocket.
*/
export class Resources {
  private readonly entries = new Map<string, Resource<unknown>>();

  /** Read or allocate a scoped runtime owner from validated bootstrap data.
  @param url - Unscoped resource identity.
  @param schema - Validator for bootstrap and fetched data.
  @returns Shared resource owner.
  */
  read = <T>(url: string, schema: ZodType<T>) => {
    let resource = this.entries.get(url);

    if (!resource) {
      const data = this.initial[url] === undefined ? undefined : schema.parse(this.initial[url]);

      resource = new Resource<unknown>(this.scope(url), schema, data);
      this.entries.set(url, resource);
    }

    if (!hasResourceSchema(resource, schema)) {
      throw new Error("A resource endpoint cannot use conflicting validation schemas.");
    }

    return resource;
  };

  /** Restart a known resource's active subscription.
  @param url - Unscoped resource identity.
  */
  refresh = (url: string) => {
    this.entries.get(url)?.refresh();
  };

  /** Retain explicit bootstrap and endpoint dependencies.
  @param scope - Runtime URL resolver for one selected Pocket.
  @param initial - Serialized resource data.
  */
  constructor(
    private readonly scope: (url: string) => string,
    private readonly initial: Record<string, unknown>
  ) {}
}

import { z } from "zod";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 256;
const TYPO_LENGTH_DIVISOR = 4;
const BEFORE = -1;

export const modelCatalogQuerySchema = z
  .object({
    provider: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
    model: z.string().trim().min(1).max(MAX_QUERY_LENGTH).optional(),
    view: z.enum(["providers", "names", "details"]).optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(MAX_PAGE_SIZE).optional(),
  })
  .strict()
  .refine((query) => !query.model || query.view !== "providers", "Model lookup cannot use the providers view.");

export type ModelCatalogQuery = z.infer<typeof modelCatalogQuerySchema>;

/** Read the public catalog query from the existing session URL, excluding route identity fields.
@param params - HTTP search parameters.
@returns Validated lookup options using the same contract as MCP and native lookup.
*/
export function readModelCatalogQuery(params: URLSearchParams) {
  const fields = ["provider", "model", "view", "offset", "limit"];
  const values: Record<string, string | number> = {};

  for (const field of fields) {
    if (!params.has(field)) {
      continue;
    }

    const value = params.get(field) ?? "";
    const numeric = value.length > 0 ? Number(value) : NaN;

    values[field] = field === "offset" || field === "limit" ? numeric : value;
  }

  return modelCatalogQuerySchema.parse(values);
}

interface CatalogProvider {
  id: string;
  name: string;
}

interface CatalogModel {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/** Normalize provider spelling without inventing aliases or changing catalog identities.
@param value - Catalog name, ID, or user search.
@returns Case- and punctuation-insensitive matching key.
*/
function normalized(value: string) {
  return value.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");
}

/** Compare strings by code point order so ranking does not depend on the host locale.
@param left - First key.
@param right - Second key.
@returns Stable sort order.
*/
function compare(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  return left < right ? BEFORE : 1;
}

/** Supply an initial edit-distance column value.
@param _value - Unused array slot.
@param index - Column index.
@returns Initial edit distance.
*/
function indexValue(_value: unknown, index: number) {
  return index;
}

interface RankedProvider {
  provider: CatalogProvider;
  score: number;
}

/** Order equally plausible providers deterministically.
@param first - First candidate.
@param second - Second candidate.
@returns Score then exact-ID order.
*/
function compareRankedProviders(first: RankedProvider, second: RankedProvider) {
  return first.score - second.score || compare(first.provider.id, second.provider.id);
}

/** Extract the catalog identity from a ranked candidate.
@param candidate - Ranked provider.
@returns Catalog provider.
*/
function rankedProvider(candidate: RankedProvider) {
  return candidate.provider;
}

/** Copy only public provider identity fields.
@param provider - Configured provider.
@returns Detached public identity.
*/
function providerIdentity(provider: CatalogProvider) {
  return { id: provider.id, name: provider.name };
}

/** Order provider identities without host locale dependence.
@param first - First provider.
@param second - Second provider.
@returns Exact-ID order.
*/
function compareProviders(first: CatalogProvider, second: CatalogProvider) {
  return compare(first.id, second.id);
}

/** Filter models to an explicit provider identity.
@param provider - Selected provider.
@param model - Candidate model.
@returns Whether this model belongs to the selected provider.
*/
function isProviderModel(provider: string, model: CatalogModel) {
  return model.provider === provider;
}

/** Order models by provider then exact model ID.
@param first - First model.
@param second - Second model.
@returns Deterministic selection order.
*/
function compareModels(first: CatalogModel, second: CatalogModel) {
  return compare(first.provider, second.provider) || compare(first.id, second.id);
}

/** Compute edit distance for short provider-name typo searches.
@param left - Normalized query.
@param right - Normalized provider identity.
@returns Number of insertions, deletions, or substitutions.
*/
function distance(left: string, right: string) {
  let row = Array.from({ length: right.length + 1 }, indexValue);

  for (let i = 1; i <= left.length; i++) {
    const next = [i];

    for (let j = 1; j <= right.length; j++) {
      next.push(Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(left[i - 1] !== right[j - 1])));
    }

    row = next;
  }

  return row[right.length];
}

/** Rank all plausible providers; only an exact catalog ID takes precedence over name collisions.
@param providers - Installed provider identities and display names.
@param search - Provider name or ID query.
@returns Deterministically ordered candidate choices, without silently resolving ambiguity.
*/
function providerMatches(providers: readonly CatalogProvider[], search: string) {
  const exact: CatalogProvider[] = [];
  const names: RankedProvider[] = [];
  const partial: RankedProvider[] = [];
  const fuzzy: RankedProvider[] = [];
  const query = normalized(search);
  const threshold = Math.max(1, Math.floor(query.length / TYPO_LENGTH_DIVISOR));

  for (const provider of providers) {
    if (provider.id === search) {
      exact.push(provider);
    }

    const id = normalized(provider.id);
    const name = normalized(provider.name);
    const score = Math.min(distance(query, id), distance(query, name));
    const ranked = { provider, score };

    if (id === query || name === query) {
      names.push(ranked);
    }

    if (id.includes(query) || name.includes(query)) {
      partial.push(ranked);
    }

    if (score <= threshold) {
      fuzzy.push(ranked);
    }
  }

  if (!query || exact.length > 0) {
    return exact;
  }

  const candidates = names.length > 0 ? names : partial;
  const matches = candidates.length > 0 ? candidates : fuzzy;

  return Array.from(matches.toSorted(compareRankedProviders), rankedProvider);
}

/** Bound every queried list, retaining an explicit continuation even for ambiguous choices.
@param values - Stable ordered results.
@param query - Validated pagination settings.
@returns Page values and continuation metadata.
*/
function page<T>(values: T[], query: ModelCatalogQuery) {
  const offset = query.offset ?? 0;
  const end = offset + (query.limit ?? DEFAULT_PAGE_SIZE);

  return { values: values.slice(offset, end), total: values.length, nextOffset: end < values.length ? end : null };
}

/** Expose only supported catalog fields, with explicit nulls for absent capability metadata.
@param model - Authoritative configured model entry.
@returns Exact selection identity and readable capabilities.
*/
function details(model: CatalogModel) {
  return {
    id: `${model.provider}/${model.id}`,
    modelId: model.id,
    provider: model.provider,
    name: model.name,
    reasoning: model.reasoning ?? null,
    contextWindow:
      model.contextWindow !== undefined && model.contextWindow > 0 && Number.isFinite(model.contextWindow)
        ? model.contextWindow
        : null,
  };
}

/** Project the requested model view.
@param shouldShowDetails - Whether capability details were requested.
@param model - Configured catalog model.
@returns Exact details or the concise model name.
*/
function modelValue(shouldShowDetails: boolean, model: CatalogModel) {
  return shouldShowDetails ? details(model) : model.name;
}

/** Resolve exact selection IDs before bare IDs and display names, retaining cross-provider ambiguity.
@param models - Provider-filtered catalog.
@param search - Exact ID or model display name.
@returns Matching catalog entries.
*/
function modelMatches(models: readonly CatalogModel[], search: string) {
  const qualified: CatalogModel[] = [];
  const ids: CatalogModel[] = [];
  const names: CatalogModel[] = [];

  for (const model of models) {
    if (`${model.provider}/${model.id}` === search) {
      qualified.push(model);
    }

    if (model.id === search) {
      ids.push(model);
    }

    if (model.name.toLowerCase() === search.toLowerCase()) {
      names.push(model);
    }
  }

  if (qualified.length > 0) {
    return qualified;
  }

  return ids.length > 0 ? ids : names;
}

/** Query the installed catalog without changing session selections or consulting credentials.
@param models - Authoritative configured chat models.
@param providers - Authoritative provider IDs and display names.
@param query - Validated lookup and pagination options.
@returns Concise model names, exact details, or explicit candidate choices.
*/
export function queryModelCatalog(
  models: readonly CatalogModel[],
  providers: readonly CatalogProvider[],
  query: ModelCatalogQuery
) {
  const identities = Array.from(providers, providerIdentity);
  const matches = query.provider ? providerMatches(identities, query.provider) : identities.toSorted(compareProviders);

  if (query.view === "providers" || (query.provider && matches.length !== 1)) {
    const { values, ...pagination } = page(matches, query);

    let status = "ok";

    if (matches.length === 0) {
      status = "provider_not_found";
    } else if (query.provider && matches.length > 1) {
      status = "ambiguous_provider";
    }

    return { status, providers: values, ...pagination };
  }

  const scoped = query.provider ? models.filter(isProviderModel.bind(undefined, matches[0].id)) : [...models];
  const selected = query.model ? modelMatches(scoped, query.model) : scoped;
  const ordered = selected.toSorted(compareModels);

  if (query.model && ordered.length === 1) {
    return { status: "ok", model: details(ordered[0]) };
  }

  const { values, ...pagination } = page(ordered, query);

  let status = "ok";

  if (query.model) {
    status = ordered.length > 0 ? "ambiguous_model" : "model_not_found";
  }

  return {
    status,
    ...(query.provider && { provider: matches[0] }),
    models: Array.from(values, modelValue.bind(undefined, !!query.model || query.view === "details")),
    ...pagination,
  };
}

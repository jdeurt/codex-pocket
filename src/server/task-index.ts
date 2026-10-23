import { createStore } from "@tobilu/qmd";
import { stat } from "node:fs/promises";
import { lock } from "proper-lockfile";
import path from "node:path";
import { taskDirectory } from "./task-archive";
import { optionalTaskFile, reconcileTaskViews, taskIndexDirectory } from "./task-index-views";
import { type RetrievalMode, searchTaskIndex } from "./task-index-search";

const LOCK_RETRIES = 120;
const LOCK_RETRY_MS = 250;

/** Accept only existing absolute local GGUF paths, never URIs or implicit model downloads.
@param value - Optional model path from Pocket's environment.
@returns Valid local path, or undefined when unavailable.
*/
async function localModel(value: string | undefined) {
  if (!value || !path.isAbsolute(value) || !value.endsWith(".gguf")) {
    return;
  }

  const info = await optionalTaskFile(() => stat(value));

  return info?.isFile() ? value : undefined;
}

/** Resolve local capabilities before any QMD inference operation can initialize a model.
@param isKeywordOnly - Force the model-free recovery path after a worker crash or timeout.
@returns Model paths and truthful initial retrieval availability.
*/
async function localCapabilities(isKeywordOnly: boolean) {
  const embed = isKeywordOnly ? undefined : await localModel(process.env.POCKET_QMD_EMBED_MODEL);
  const rerank = isKeywordOnly ? undefined : await localModel(process.env.POCKET_QMD_RERANK_MODEL);
  const retrieval: RetrievalMode = {
    engine: "@tobilu/qmd",
    mode: embed ? "hybrid" : "keyword",
    reranked: !!rerank,
    reasons: [],
  };

  if (!embed) {
    retrieval.reasons.push("Local embedding model unavailable; using QMD BM25 keyword retrieval.");
  }

  if (!rerank) {
    retrieval.reasons.push("Local reranking model unavailable; model reranking disabled.");
  }

  return { embed, rerank, retrieval };
}

/** Downgrade semantic retrieval when QMD reports incomplete embedding work.
@param errors - QMD's count of failed chunks.
@param retrieval - Current capability status.
*/
function reportEmbeddingErrors(errors: number, retrieval: RetrievalMode) {
  if (!(errors > 0)) {
    return;
  }

  retrieval.mode = "keyword";
  retrieval.reasons.push(`${String(errors)} embedding chunks failed; using QMD keyword retrieval.`);
}

/** Attempt optional local embeddings while retaining QMD keyword functionality on inference failures.
@param store - Current parent's index.
@param model - Existing local GGUF file.
@param retrieval - Capability state to downgrade if indexing failed.
*/
async function embedLocal(store: Awaited<ReturnType<typeof createStore>>, model: string, retrieval: RetrievalMode) {
  try {
    const result = await store.embed({ model, collection: "tasks" });

    reportEmbeddingErrors(result.errors, retrieval);
  } catch (error) {
    retrieval.mode = "keyword";
    retrieval.reasons.push(`Local embeddings unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Take the optional inference slot without delaying keyword retrieval behind a local model job.
@param owner - Private parent namespace.
@param retrieval - Capability state to downgrade when another worker owns local inference.
@returns A release callback, or null when inference is busy/unavailable.
*/
async function inferenceSlot(owner: string, retrieval: RetrievalMode) {
  try {
    return await lock(path.join(taskDirectory(owner), "qmd", "inference"), { realpath: false });
  } catch (error) {
    retrieval.mode = "keyword";
    retrieval.reranked = false;
    retrieval.reasons.push(`Local inference busy or unavailable; using keyword retrieval: ${String(error)}`);

    return null;
  }
}

/** Run only model work for which this process owns the optional inference slot.
@param store - Parent index.
@param owner - Authorized parent.
@param documents - Reconciled readable pages.
@param embed - Local embedding model, if available.
@param query - Optional search query.
@param offset - Page offset.
@param retrieval - Actual capability state.
@returns A source-validated search page.
*/
async function modelSearch(
  store: Awaited<ReturnType<typeof createStore>>,
  owner: string,
  documents: Awaited<ReturnType<typeof reconcileTaskViews>>,
  embed: string | undefined,
  query: string | undefined,
  offset: number,
  retrieval: RetrievalMode
) {
  if (embed && documents.length > 0) {
    await embedLocal(store, embed, retrieval);
  }

  return searchTaskIndex(store, owner, documents, query ?? "", offset, retrieval);
}

/** Update the collection and optional vectors before serving a query.
@param store - Private store.
@param owner - Parent identity.
@param documents - Reconciled readable source pages.
@param embed - Optional verified local model.
@param query - Optional user query.
@param offset - Pagination offset.
@param retrieval - Current capability status.
@param releaseIndex - Release filesystem reconciliation before optional inference starts.
@returns Search results and actual retrieval mode.
*/
async function refreshStore(
  store: Awaited<ReturnType<typeof createStore>>,
  owner: string,
  documents: Awaited<ReturnType<typeof reconcileTaskViews>>,
  embed: string | undefined,
  query: string | undefined,
  offset: number,
  retrieval: RetrievalMode,
  releaseIndex: () => Promise<void>
) {
  await store.update({ collections: ["tasks"] });

  await releaseIndex();

  if (!embed && !retrieval.reranked) {
    return searchTaskIndex(store, owner, documents, query ?? "", offset, retrieval);
  }

  const release = await inferenceSlot(owner, retrieval);

  if (!release) {
    return searchTaskIndex(store, owner, documents, query ?? "", offset, retrieval);
  }

  try {
    return await modelSearch(store, owner, documents, embed, query, offset, retrieval);
  } finally {
    await release();
  }
}

/** Own the store lifecycle while holding the cross-process parent lock.
@param owner - Authorized parent.
@param query - Optional query after reconciliation.
@param offset - Result-page offset.
@param isKeywordOnly - Whether inference is disabled for recovery.
@param releaseIndex - Release the parent index lock once Markdown and keyword updates are committed.
@returns A search page or an indexing acknowledgement.
*/
async function updateAndSearch(
  owner: string,
  query: string | undefined,
  offset: number,
  isKeywordOnly: boolean,
  releaseIndex: () => Promise<void>
) {
  const directory = path.join(taskDirectory(owner), "qmd");
  const documents = await reconcileTaskViews(owner);
  const { embed, rerank, retrieval } = await localCapabilities(isKeywordOnly);
  // Even an accidental inference call cannot resolve a remote/default model.
  const unavailable = path.join(directory, "unavailable-local-model.gguf");

  // QMD 2.8.3 token chunking also consults a process-global tokenizer. This worker handles one
  // parent only; pin its documented model environment as well as the per-store SDK config.
  process.env.QMD_EMBED_MODEL = embed ?? unavailable;
  process.env.QMD_RERANK_MODEL = rerank ?? unavailable;
  process.env.QMD_GENERATE_MODEL = unavailable;
  const store = await createStore({
    dbPath: path.join(directory, "index.sqlite"),
    config: {
      collections: { tasks: { path: path.join(directory, "views"), pattern: "*.md" } },
      models: { embed: embed ?? unavailable, rerank: rerank ?? unavailable, generate: unavailable },
    },
  });

  try {
    return await refreshStore(store, owner, documents, embed, query, offset, retrieval, releaseIndex);
  } finally {
    await store.close();
  }
}

/** Reconcile and query one private QMD store in a dedicated host subprocess.
@param owner - Authorized Pocket parent identity.
@param query - Search query, or undefined for a background index update.
@param offset - Result-page offset.
@param isKeywordOnly - Skip optional inference after an earlier worker failure.
@returns Search page with actual capability information, or update status.
*/
export async function runTaskIndex(owner: string, query?: string, offset = 0, isKeywordOnly = false) {
  const directory = await taskIndexDirectory(owner);
  const unlock = await lock(directory, {
    retries: { retries: LOCK_RETRIES, factor: 1, minTimeout: LOCK_RETRY_MS, maxTimeout: LOCK_RETRY_MS },
  });

  let isReleased = false;

  const release = async () => {
    if (isReleased) {
      return;
    }

    isReleased = true;
    await unlock();
  };

  try {
    return await updateAndSearch(owner, query, offset, isKeywordOnly, release);
  } finally {
    await release();
  }
}

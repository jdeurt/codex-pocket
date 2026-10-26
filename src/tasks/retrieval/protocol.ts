import { z } from "zod";

const MAX_QUERY_LENGTH = 2000;

export const taskIndexRequest = z.object({
  owner: z.string().min(1),
  query: z.string().max(MAX_QUERY_LENGTH).optional(),
  offset: z.number().int().nonnegative().default(0),
  isKeywordOnly: z.boolean().default(false),
});

const retrievalSchema = z.object({
  engine: z.literal("@tobilu/qmd"),
  mode: z.enum(["keyword", "hybrid"]),
  reranked: z.boolean(),
  reasons: z.array(z.string()),
});
const passageSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  startLine: z.number(),
  endLine: z.number(),
  offsetUnit: z.string(),
  omittedBefore: z.number(),
  omittedAfter: z.number(),
  matchedTerms: z.array(z.string()),
});
const contextSchema = z.object({
  sourceId: z.string(),
  sequence: z.number(),
  file: z.string(),
  excerpt: z.string(),
  truncated: z.boolean(),
});
const sourceSchema = z.object({
  namespace: z.enum(["codex", "native"]),
  id: z.string(),
  sequence: z.number(),
  file: z.string(),
  timestamp: z.string().nullable(),
});
const associationSpan = z.object({ start: z.number().int(), end: z.number().int() });
const associationSchema = z.object({ taskId: z.string(), eventId: z.string(), span: associationSpan.optional() });

const resultSchema = z.object({
  taskAssociations: z.array(associationSchema),
  file: z.string(),
  taskFile: z.string(),
  score: z.number(),
  excerpt: z.string(),
  passage: passageSchema,
  context: z.array(contextSchema),
  source: sourceSchema,
  ranking: z.unknown(),
  retrieval: retrievalSchema,
});
const paginationSchema = z.object({
  offset: z.number(),
  limit: z.number(),
  candidateLimit: z.number(),
  totalCandidates: z.number(),
  nextOffset: z.number().nullable(),
  candidateWindowFull: z.boolean(),
});

export const taskSearchPage = z.object({
  results: z.array(resultSchema),
  retrieval: retrievalSchema,
  pagination: paginationSchema,
});
export const taskIndexReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), page: taskSearchPage }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

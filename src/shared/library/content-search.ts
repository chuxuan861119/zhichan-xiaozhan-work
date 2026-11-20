import { z } from "zod";
import { PatentTypeSchema } from "../patent/model.js";

export const ContentSearchRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("configure"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("purge-patent"), patentId: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("cancel-search"), searchId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal("search"),
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL must be rejected at the search input boundary.
        .regex(/^[^\u0000]*$/u),
      searchId: z.string().min(1).max(100).optional(),
      after: z.string().max(200).optional(),
      indexVersion: z.string().max(100).optional(),
      patentType: PatentTypeSchema.optional(),
      offset: z.number().int().min(0).max(100000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search-details"),
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL must be rejected at the search input boundary.
        .regex(/^[^\u0000]*$/u),
      patentId: z.string().min(1).max(200),
      indexVersion: z.string().max(100).optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
]);
export const ContentSearchBookSchema = z.object({
  kind: z.enum(["claims", "description", "description-drawings", "abstract", "abstract-drawing"]),
  count: z.number().int().nonnegative(),
  snippets: z.array(z.string()),
  locations: z
    .array(
      z.object({
        occurrence: z.number().int().nonnegative(),
        queryOffset: z.number().int().nonnegative(),
        nodeId: z.string().optional(),
        textOffset: z.number().int().nonnegative().optional(),
        annotation: z.enum(["name", "note"]).optional(),
      }),
    )
    .optional(),
});
export const ContentSearchStateSchema = z.object({
  indexPhase: z.enum(["idle", "running", "completed", "partial", "failed", "cancelled"]).optional(),
  runId: z.string().optional(),
  indexedCount: z.number().int().nonnegative().optional(),
  pendingCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  indexVersion: z.string().optional(),
  sourceVersion: z.string().optional(),
  versionChanged: z.boolean().optional(),
  manual: z.boolean().optional(),
  paused: z.boolean().optional(),
  enabled: z.boolean(),
  running: z.boolean(),
  completed: z.number(),
  total: z.number(),
  updatedAt: z.string().nullable(),
  error: z.boolean(),
  incomplete: z.boolean(),
  hits: z
    .array(z.object({ patentId: z.string(), books: z.array(ContentSearchBookSchema) }))
    .optional(),
  nextCursor: z.string().nullable().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
  cancelled: z.boolean().optional(),
  searchError: z.boolean().optional(),
  hasMore: z.boolean().optional(),
});
export type ContentSearchRequest = z.infer<typeof ContentSearchRequestSchema>;
export type ContentSearchState = z.infer<typeof ContentSearchStateSchema>;
export type ContentSearchBook = z.infer<typeof ContentSearchBookSchema>;
export type ContentSearchLocation = NonNullable<ContentSearchBook["locations"]>[number];

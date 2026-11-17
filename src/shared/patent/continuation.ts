import { z } from "zod";
import { JsonObjectSchema } from "../ipc/primitives.js";
import { type CanonicalPatent, PatentBookKindSchema } from "./model.js";

const PaneSchema = z
  .object({ bookKind: PatentBookKindSchema, zoomPercent: z.number().min(10).max(400) })
  .strict();
export const PatdocWorkspaceSchema = z
  .object({
    version: z.literal(1),
    activeBookKind: PatentBookKindSchema,
    zoomPercent: z.number().min(10).max(400),
    columns: z.boolean(),
    columnZoomPercent: z.number().min(10).max(400),
    dual: z
      .object({ left: PaneSchema, right: PaneSchema, activePane: z.enum(["left", "right"]) })
      .strict()
      .optional(),
    books: z
      .array(
        z
          .object({
            bookKind: PatentBookKindSchema,
            scrollTop: z.number().finite().min(0).max(1e9),
            selection: z
              .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(5),
    aiCorrectionOpen: z.boolean(),
    assistantOpen: z.boolean(),
  })
  .strict();
export type PatdocWorkspace = z.infer<typeof PatdocWorkspaceSchema>;
export const PATDOC_WORKSPACE_KEY = "patdocWorkspace";

export function readPatdocWorkspace(patent: CanonicalPatent): PatdocWorkspace | null {
  const parsed = PatdocWorkspaceSchema.safeParse(
    patent.books.find((book) => book.kind === "description")?.editorState[PATDOC_WORKSPACE_KEY],
  );
  return parsed.success ? parsed.data : null;
}

export function withPatdocWorkspace(patent: CanonicalPatent, input: unknown): CanonicalPatent {
  const workspace = PatdocWorkspaceSchema.parse(input);
  return {
    ...patent,
    activeBookKind: workspace.activeBookKind,
    books: patent.books.map((book) =>
      book.kind === "description"
        ? {
            ...book,
            editorState: {
              ...book.editorState,
              [PATDOC_WORKSPACE_KEY]: JsonObjectSchema.parse(JSON.parse(JSON.stringify(workspace))),
            },
          }
        : book,
    ),
  };
}

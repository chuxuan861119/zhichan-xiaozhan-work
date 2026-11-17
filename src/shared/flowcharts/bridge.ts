import { z } from "zod";
import {
  FLOWCHART_MAX_FRAME_MESSAGE_BYTES,
  FLOWCHART_MAX_PAGES,
  FLOWCHART_MAX_SOURCE_XML_BYTES,
  FLOWCHART_MAX_SVG_BYTES,
} from "./limits.js";

const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TEXT_LENGTH = FLOWCHART_MAX_FRAME_MESSAGE_BYTES;
const IdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/);
const RevisionSchema = z.number().int().nonnegative();
const EnvelopeSchema = z
  .object({
    sessionId: IdentifierSchema,
    projectId: IdentifierSchema,
    projectRevision: RevisionSchema,
    requestId: IdentifierSchema,
  })
  .strict();
const ExportFormatSchema = z.enum(["drawio", "svg", "png", "jpeg", "pdf"]);
const EditorModeSchema = z.enum(["flowchart", "circuit"]);
const OfflineEditorPolicySchema = z
  .object({
    cloud: z.literal(false),
    templates: z.literal(false),
    help: z.literal(false),
    updates: z.literal(false),
    plugins: z.literal(false),
    grid: z.literal(false),
    shadow: z.literal(false),
  })
  .strict();
const PageSchema = z.object({ id: IdentifierSchema, name: z.string().min(1).max(512) }).strict();
const PageIdSchema = IdentifierSchema;
const ToolbarNameSchema = z.string().min(1).max(512);
const ToolbarSaveStatusSchema = z.enum(["loading", "saved", "dirty", "saving", "error"]);
const ToolbarActionSchema = z.enum([
  "toggle-project-menu",
  "save",
  "export-external",
  "export-to-description-drawing",
  "replace-description-drawing",
  "project-create",
  "project-import",
  "project-rename",
  "project-duplicate",
  "project-delete",
  "cycle-tab-next",
  "cycle-tab-previous",
]);
const ToolbarStatePayloadSchema = z
  .object({
    projectName: ToolbarNameSchema,
    activePageName: ToolbarNameSchema.nullable(),
    saveStatus: ToolbarSaveStatusSchema,
    dirty: z.boolean(),
    saveBusy: z.boolean(),
    exportBusy: z.boolean(),
    canReplaceDrawing: z.boolean().optional(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
const TextSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .refine((value) => utf8ByteLength(value) <= MAX_TEXT_LENGTH);
const SourceSchema = z
  .string()
  .max(FLOWCHART_MAX_SOURCE_XML_BYTES)
  .refine((value) => utf8ByteLength(value) <= FLOWCHART_MAX_SOURCE_XML_BYTES);

export const DrawioHostMessageSchema = z.discriminatedUnion("type", [
  EnvelopeSchema.extend({
    type: z.literal("motion-preference"),
    reducedMotion: z.boolean(),
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("configure"),
    locale: z.enum(["zh_CN", "en"]).default("zh_CN"),
    policy: OfflineEditorPolicySchema,
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("load"), source: SourceSchema }).strict(),
  EnvelopeSchema.extend({ type: z.literal("activate-session"), source: SourceSchema }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("request-save"),
    finishEditing: z.boolean().optional(),
    preserveEditing: z.boolean().optional(),
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("undo") }).strict(),
  EnvelopeSchema.extend({ type: z.literal("redo") }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("request-export"),
    format: ExportFormatSchema,
    selectionOnly: z.boolean().default(false),
    allPages: z.boolean().optional(),
    pageId: IdentifierSchema.optional(),
    selectedCellIds: z.array(z.string().min(1).max(500)).min(1).max(50_000).optional(),
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("set-page"), pageId: PageIdSchema }).strict(),
  EnvelopeSchema.extend({ type: z.literal("set-editor-mode"), mode: EditorModeSchema }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("toolbar-action-ack"),
    actionId: IdentifierSchema,
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("toolbar-state"),
    ...ToolbarStatePayloadSchema.shape,
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("dispose") }).strict(),
]);

const DrawioFrameMessageBaseSchema = z.discriminatedUnion("type", [
  EnvelopeSchema.extend({
    type: z.literal("ready"),
    pages: z.array(PageSchema).max(FLOWCHART_MAX_PAGES).default([]),
    activePageId: PageIdSchema.optional(),
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("changed") }).strict(),
  EnvelopeSchema.extend({ type: z.literal("autosave"), source: SourceSchema }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("export-result"),
    format: ExportFormatSchema,
    data: TextSchema,
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("page-changed"), pageId: PageIdSchema }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("editor-mode-changed"),
    mode: EditorModeSchema,
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("toolbar-action"),
    action: ToolbarActionSchema,
    actionId: IdentifierSchema,
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("history-state"),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("selection-changed"),
    selectionCount: z.number().int().min(0).max(50_000),
    selectedCellIds: z.array(z.string().min(1).max(500)).max(50_000),
  }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("error"),
    code: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1).max(512),
  }).strict(),
]);

export const DrawioFrameMessageSchema = DrawioFrameMessageBaseSchema.superRefine(
  (message, context) => {
    if (utf8ByteLength(JSON.stringify(message)) > FLOWCHART_MAX_FRAME_MESSAGE_BYTES)
      context.addIssue({ code: "custom", message: "frame message exceeds byte limit" });
    if (
      message.type === "export-result" &&
      message.format === "svg" &&
      utf8ByteLength(message.data) > FLOWCHART_MAX_SVG_BYTES
    )
      context.addIssue({ code: "custom", message: "SVG exceeds byte limit" });
  },
);

export type DrawioHostMessage = z.infer<typeof DrawioHostMessageSchema>;
export type DrawioFrameMessage = z.infer<typeof DrawioFrameMessageSchema>;
export type DrawioExportFormat = z.infer<typeof ExportFormatSchema>;
export type FlowchartEditorMode = z.infer<typeof EditorModeSchema>;
export type DrawioExportRequest = {
  format: z.infer<typeof ExportFormatSchema>;
  selectionOnly?: boolean;
  allPages?: boolean;
  pageId?: string;
  selectedCellIds?: string[];
};
export type DrawioToolbarState = z.infer<typeof ToolbarStatePayloadSchema>;
export type DrawioToolbarAction = z.infer<typeof ToolbarActionSchema>;

export function isDrawioHostMessage(value: unknown): value is DrawioHostMessage {
  return DrawioHostMessageSchema.safeParse(value).success;
}
export function isDrawioFrameMessage(value: unknown): value is DrawioFrameMessage {
  return DrawioFrameMessageSchema.safeParse(value).success;
}

import { z } from "zod";
import type { CanonicalPatent } from "../patent/model.js";
import { AutomationGlobalPermissionsSchema } from "./global.js";

export const AUTOMATION_PROTOCOL_VERSION = 2;
export const AUTOMATION_CREATE_BATCH = 5;
export const AUTOMATION_LEASE_MS = 30 * 60 * 1000;
export const MAX_AUTOMATION_FRAME = 16 * 1024 * 1024;
export const AUTOMATION_UI_CHANNEL = "automation:control";
export const AUTOMATION_EVENT_CHANNEL = "automation:event";
export const AUTOMATION_COMMANDS = [
  "version",
  "capabilities",
  "doctor",
  "pair.begin",
  "pair.poll",
  "pair.renew-create",
  "workspace.select",
  "patent.list",
  "patent.search",
  "patent.read",
  "patent.create",
  "patent.import",
  "docx.prepare",
  "docx.preview",
  "docx.preview-asset",
  "docx.commit",
  "docx.discard",
  "patent.sync",
  "patent.inspect",
  "ai.correct",
  "ai.polish",
  "ai.conversation.read",
  "ai.conversation.run",
  "flowchart.list",
  "flowchart.read",
  "flowchart.write",
  "flowchart.render",
  "patent.show",
  "patent.close",
  "patent.trash",
  "patent.restore",
  "patent.delete",
  "template.list",
  "template.describe",
  "change.prepare",
  "change.inspect",
  "change.apply",
  "change.discard",
  "change.restore-prepare",
  "asset.read",
  "asset.import",
  "drawing.import",
  "drawing.render",
  "asset.render-formula",
  "asset.render-chemistry",
  "asset.preview",
  "asset.export",
  "flowchart.export",
  "asset.discard",
  "patent.export",
  "patent.export-bundle",
  "patent.printers",
  "patent.print",
  "operation.status",
  "operation.cancel",
  "history.list",
  "history.create",
  "history.delete",
  "history.preview",
  "manual",
  "global.models.read",
  "global.models.test-connection",
  "global.models.discover",
  "global.library.read",
  "global.transfer.read",
  "global.transfer.export",
  "global.transfer.relocate",
  "global.transfer.import.prepare",
  "global.transfer.import.read",
  "global.transfer.import.discard",
  "global.transfer.import.commit",
  "global.library.backup.read",
  "global.library.backup.run",
  "global.library.backup.delete",
  "global.library.backup.restore",
  "global.documents.read",
  "global.documents.legacy.read",
  "global.documents.legacy.import",
  "global.documents.create",
  "global.documents.update",
  "global.documents.import",
  "global.documents.export",
  "global.documents.print",
  "global.documents.printers.read",
  "global.documents.asset-import",
  "global.documents.trash",
  "global.documents.restore",
  "global.documents.delete",
  "global.library.backup.configure",
  "global.library.snapshot.configure",
  "global.models.update",
  "global.models.set-key",
  "global.models.clear-key",
  "global.settings.read",
  "global.settings.update",
  "global.template.read",
  "global.template.update",
] as const;
export const AutomationAuthorizationRequestSchema = z
  .object({
    task: z.string().trim().min(1).max(1000).optional(),
    patents: z
      .array(
        z
          .object({
            patentId: z.string().uuid().optional(),
            name: z.string().trim().min(1).max(500).optional(),
            access: z.enum(["read", "full"]),
          })
          .strict()
          .refine((p) => !!(p.patentId || p.name), "需要专利 ID 或名称"),
      )
      .max(10000)
      .optional(),
    createLimit: z.number().int().min(0).max(100).optional(),
    global: AutomationGlobalPermissionsSchema.optional(),
  })
  .strict();
export type AutomationAuthorizationRequest = z.infer<typeof AutomationAuthorizationRequestSchema>;
export const AutomationWorkspaceSelectionSchema = z
  .object({
    kind: z.enum(["import", "export"]),
    directory: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const AutomationScopeSchema = z
  .object({
    patents: z
      .record(z.string().uuid(), z.enum(["read", "full"]))
      .refine((ids) => Object.keys(ids).length <= 10000),
    global: AutomationGlobalPermissionsSchema.optional(),
    createLimit: z.number().int().min(0).max(AUTOMATION_CREATE_BATCH),
    workspace: z
      .object({
        importDirectory: z.string().min(1).optional(),
        exportDirectory: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type AutomationScope = z.infer<typeof AutomationScopeSchema>;
export type ResolvedAutomationScope = Omit<AutomationScope, "workspace"> & {
  workspace: { importDirectory: string; exportDirectory: string };
};
export const AutomationRequestSchema = z
  .object({
    protocolVersion: z.literal(AUTOMATION_PROTOCOL_VERSION),
    instanceId: z.string().uuid(),
    libraryId: z.string().uuid(),
    accessKey: z.string().min(32).max(128),
    command: z.enum(AUTOMATION_COMMANDS),
    requestId: z.string().min(1).max(128),
    token: z.string().max(128).optional(),
    clientProof: z.string().min(32).max(128).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AutomationRequest = z.infer<typeof AutomationRequestSchema>;
export type AutomationResponse =
  | { ok: true; value: unknown; protocolVersion: typeof AUTOMATION_PROTOCOL_VERSION }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
      protocolVersion: typeof AUTOMATION_PROTOCOL_VERSION;
    };
export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}
export type AutomationDescriptor = {
  instanceId: string;
  libraryId: string;
  endpoint: string;
  accessKey: string;
  protocolVersion: number;
  version: string;
  label: string;
  pid: number;
};
export const AutomationUiRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("closeAck"),
      token: z.string().uuid(),
      sessionId: z.string().uuid(),
      ok: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("accessInstructions") }).strict(),
  z
    .object({
      action: z.literal("setEnabled"),
      enabled: z.boolean(),
      policyAcceptedVersion: z.string().max(64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("approvePair"),
      pairId: z.string().uuid(),
      scope: AutomationScopeSchema,
    })
    .strict(),
  z.object({ action: z.literal("rejectPair"), pairId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("revoke"), grantId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("updateGrant"),
      grantId: z.string().uuid(),
      scope: AutomationScopeSchema,
    })
    .strict(),
  z.object({ action: z.literal("discardChange"), changeId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("discardAssets") }).strict(),
  z.object({ action: z.literal("resync"), patentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("chooseDirectory"), kind: z.enum(["import", "export"]) }).strict(),
  z
    .object({
      action: z.literal("barrierAck"),
      token: z.string().uuid(),
      sessionId: z.string().uuid(),
      phase: z.enum(["probe", "drain", "adopt"]),
      ok: z.boolean(),
      dirty: z.boolean(),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type AutomationUiRequest = z.infer<typeof AutomationUiRequestSchema>;
export type AutomationEvent =
  | { type: "stateChanged" }
  | { type: "libraryChanged"; command?: string; patentIds: string[]; createdPatentIds?: string[] }
  | { type: "show"; patentId: string }
  | { type: "close"; patentId: string; sessionId: string; token: string }
  | {
      type: "barrier";
      token: string;
      patentId: string;
      phase: "probe" | "drain" | "adopt" | "release";
      committed?: boolean;
      patent?: CanonicalPatent;
    };
export type AutomationUiState = {
  enabled: boolean;
  instance: Omit<AutomationDescriptor, "accessKey"> | null;
  pendingPairs: Array<{
    pairId: string;
    clientId: string;
    label: string;
    expiresAt: number;
    requested?: AutomationAuthorizationRequest;
    creationRenewal?: boolean;
  }>;
  grants: Array<{
    grantId: string;
    clientId: string;
    label: string;
    scope: ResolvedAutomationScope;
    taskId: string;
    createdCount: number;
    creationRemaining?: number;
  }>;
  changes: Array<{
    changeId: string;
    patentId: string;
    name: string | null;
    clientLabel: string;
    expectedRevision: number;
    risk: { requireApproval: boolean; reasons: string[] };
    diff: unknown;
    expiresAt: number;
  }>;
  stagedAssetCount: number;
};

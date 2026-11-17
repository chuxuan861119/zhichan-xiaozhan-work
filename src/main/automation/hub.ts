import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { AutomationCorrectionSchema, AutomationPolishSchema } from "../../shared/automation/ai.js";
import {
  AutomationAssetExportSchema,
  AutomationAssetImportSchema,
  AutomationChemicalSchema,
  AutomationFormulaSchema,
} from "../../shared/automation/assets.js";
import { AutomationBundleExportSchema } from "../../shared/automation/bundles.js";
import {
  AutomationOperationsSchema,
  prepareAutomationChange,
} from "../../shared/automation/changes.js";
import {
  AutomationConversationReadSchema,
  AutomationConversationRunSchema,
} from "../../shared/automation/conversations.js";
import * as documentSchemas from "../../shared/automation/documents.js";
import {
  AutomationDocxAssetSchema,
  AutomationDocxCommitSchema,
  AutomationDocxPrepareSchema,
  AutomationDocxSessionSchema,
} from "../../shared/automation/docx.js";
import {
  AutomationDrawingImportSchema,
  AutomationDrawingRenderSchema,
  DRAWING_OPERATIONS,
} from "../../shared/automation/drawings.js";
import {
  AutomationFlowchartExportSchema,
  AutomationFlowchartRenderSchema,
  AutomationFlowchartWriteSchema,
} from "../../shared/automation/flowcharts.js";
import {
  AutomationGeneralSettingsPatchSchema,
  type AutomationGlobalDomain,
  AutomationModelProbeSchema,
  AutomationModelsPatchSchema,
  commandGlobalDomain,
  generalSettings,
  modelSettings,
} from "../../shared/automation/global.js";
import type {
  AutomationDrawingTileLease,
  AutomationGraphicRequest,
  AutomationGraphicResult,
} from "../../shared/automation/graphics.js";
import {
  AutomationSnapshotCreateSchema,
  AutomationSnapshotDeleteSchema,
} from "../../shared/automation/history.js";
import { AutomationPatentImportSchema } from "../../shared/automation/imports.js";
import {
  AutomationBackupConfigureSchema,
  AutomationBackupDeleteSchema,
  AutomationBackupReadSchema,
  AutomationBackupRunSchema,
  AutomationSnapshotConfigureSchema,
  librarySettings,
} from "../../shared/automation/library.js";
import {
  AutomationTrashItemSchema,
  AutomationTrashSchema,
} from "../../shared/automation/lifecycle.js";
import {
  AUXILIARY_OPERATIONS,
  PATENT_SETTINGS_OPERATIONS,
} from "../../shared/automation/patent-operations.js";
import { AGENT_CLI_POLICY_VERSION } from "../../shared/automation/policy.js";
import { AutomationPrintSchema } from "../../shared/automation/printing.js";
import {
  AUTOMATION_COMMANDS,
  AUTOMATION_CREATE_BATCH,
  AUTOMATION_LEASE_MS,
  AUTOMATION_PROTOCOL_VERSION,
  type AutomationAuthorizationRequest,
  AutomationAuthorizationRequestSchema,
  AutomationError,
  type AutomationEvent,
  type AutomationRequest,
  type AutomationScope,
  AutomationScopeSchema,
  type AutomationUiRequest,
  AutomationUiRequestSchema,
  type AutomationUiState,
  AutomationWorkspaceSelectionSchema,
  MAX_AUTOMATION_FRAME,
  type ResolvedAutomationScope,
} from "../../shared/automation/protocol.js";
import {
  type AutomationSearchMatch,
  AutomationSearchSchema,
  searchPatent,
} from "../../shared/automation/search.js";
import {
  AutomationRelocateSchema,
  AutomationTransferCommitSchema,
  AutomationTransferExportSchema,
  AutomationTransferImportSchema,
  AutomationTransferPrepareSchema,
  AutomationTransferReadSchema,
} from "../../shared/automation/transfer.js";
import type { AssetDescriptor } from "../../shared/document/model.js";
import { MAX_DRAWING_INPUT_BYTES } from "../../shared/drawing-markup/model.js";
import { FLOWCHART_MAX_SOURCE_XML_BYTES } from "../../shared/flowcharts/limits.js";
import { DrawingImportRequestSchema, IPC_CHANNELS } from "../../shared/ipc/contract.js";
import type { CanonicalPatent } from "../../shared/patent/model.js";
import { preserveCurrentGraphicWorkspaces } from "../../shared/patent/snapshot-scope.js";
import { PatentTemplateEditorSaveRequestSchema } from "../../shared/patent/template-catalog.js";
import {
  createFactoryPatentTemplates,
  PATENT_TEMPLATE_TOKENS,
} from "../../shared/patent/templates.js";
import { DEFAULT_PATENT_INSPECTION_RULES } from "../../shared/patent-inspection/default-rules.js";
import { runPatentInspection } from "../../shared/patent-inspection/engine.js";
import {
  mergeResourceHealth,
  RESOURCE_HEALTH_RULE_ID,
} from "../../shared/patent-inspection/resource-health.js";
import type { AppSettings, AppSettingsPatch } from "../../shared/settings/model.js";
import type { AiCredentialVault } from "../ai-correction/ai-credential-vault.js";
import type { StoredAsset } from "../assets/asset-store.js";
import { importDrawing } from "../assets/drawing-importer.js";
import { openDrawingTileReader } from "../assets/drawing-tiles.js";
import { importImage, MAX_IMAGE_BYTES } from "../assets/image-importer.js";
import type { BackupService } from "../backup/backup-service.js";
import { rasterizeChemicalStructureAsset } from "../chemistry/chemical-preview-service.js";
import {
  type DataTransferOperationGate,
  getDataTransferOperationGate,
} from "../data-transfer/data-transfer-operation-gate.js";
import type { DraftService } from "../drafts/draft-service.js";
import { FormulaSyntaxError, renderFormulaFallback } from "../exports/formula-fallback.js";
import { FlowchartImportService } from "../flowcharts/flowchart-import-service.js";
import { FlowchartRenderService } from "../flowcharts/flowchart-render-service.js";
import type { FlowchartCommitContext } from "../flowcharts/flowchart-service.js";
import { inspectResourceFiles } from "../library/inspection-resources.js";
import type { LibraryRuntime } from "../library/library-runtime.js";
import type { PatentLifecycleContext } from "../library/patent-service.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { AutomationAiContext } from "./ai.js";
import { restoreAutomationBackup } from "./backups.js";
import { AutomationBarrier, type AutomationParticipant } from "./barrier.js";
import { exportAutomationBundle } from "./bundles.js";
import { AutomationPatentCloser } from "./close-patent.js";
import type { AutomationConversations } from "./conversations.js";
import {
  importAutomationDocument,
  readAutomationDocuments,
  writeAutomationDocuments,
} from "./documents.js";
import { AutomationDocxImports } from "./docx.js";
import { importAutomationPatents } from "./imports.js";
import { AutomationLedger, type OperationRecord, payloadHash } from "./ledger.js";
import {
  allowedPath,
  assertOutputReceiptScope,
  privateDirectory,
  readAllowedFile,
} from "./paths.js";
import { type AutomationPrinting, printAutomationPatent } from "./printing.js";
import { recoverPublication } from "./publication-recovery.js";
import { publishAutomationBytes } from "./publish.js";
import {
  assertAutomationChemicalSource,
  validateAutomationChemicalChanges,
} from "./scientific-content.js";
import { type AutomationTransferServices, exportAutomationTransfer } from "./transfer.js";
import {
  type AutomationTransferImportServices,
  AutomationTransferImports,
} from "./transfer-import.js";

import { AutomationTransport, errorResponse } from "./transport.js";

type Preparation = Omit<ReturnType<typeof prepareAutomationChange>, "diff"> & {
  diff: ReturnType<typeof prepareAutomationChange>["diff"] & {
    restoration?: { before: CanonicalPatent; after: CanonicalPatent };
  };
};
type Grant = {
  grantId: string;
  token: string;
  clientId: string;
  label: string;
  scope: ResolvedAutomationScope;
  taskId: string;
  createdOverrides: Set<string>;
  creationBase: number;
  active: boolean;
};
type Pair = {
  pairId: string;
  clientId: string;
  label: string;
  expiresAt: number;
  grant?: Grant;
  requested?: AutomationAuthorizationRequest;
  renewalGrant?: Grant;
};
type Prepared = {
  changeId: string;
  patentId: string;
  grant: Grant;
  expectedRevision: number;
  prepared: Preparation;
  operations: z.infer<typeof AutomationOperationsSchema>;
  expiresAt: number;
  assetHandles: string[];
  applied: boolean;
  restoreSnapshot: boolean;
};
type Stage = {
  handle: string;
  clientId: string;
  grant: Grant;
  patentId: string;
  sessionId: string;
  descriptor: AssetDescriptor;
  expiresAt: number;
  plans: Set<string>;
};
type Live = {
  record: OperationRecord;
  grant: Grant;
  controller: AbortController;
  task: Promise<void>;
};
export type AutomationHubOptions = {
  runtime: LibraryRuntime;
  home: string;
  version: string;
  label: string;
  participants(patentId: string): AutomationParticipant[];
  broadcast(event: AutomationEvent): void;
  accessInstructions?(instanceId: string): Promise<string>;
  exportPatent(
    patent: CanonicalPatent,
    payload: Record<string, unknown>,
    context: {
      signal: AbortSignal;
      grant: ResolvedAutomationScope;
      record: OperationRecord;
      ledger: AutomationLedger;
      assertAuthorized(): void;
    },
  ): Promise<unknown>;
  manual(): Promise<string>;
  chooseWorkspace?(
    kind: "import" | "export",
    directory: string | undefined,
    clientLabel: string,
  ): Promise<string | null>;
  renderPdf?: (html: string, sessionId: string) => Promise<Uint8Array>;
  renderGraphic?: (
    request: AutomationGraphicRequest,
    signal: AbortSignal,
    tiles?: AutomationDrawingTileLease,
  ) => Promise<AutomationGraphicResult>;
  printing?: AutomationPrinting;
  backup?: Pick<
    BackupService,
    "configure" | "status" | "list" | "describe" | "runGuarded" | "delete" | "capture"
  >;
  onSnapshotChanged?: () => Promise<void>;
  runAi?:
    | ((
        command: "ai.correct" | "ai.polish",
        patent: CanonicalPatent,
        payload: Record<string, unknown>,
        context: AutomationAiContext,
      ) => Promise<unknown>)
    | undefined;
  conversations?: Pick<AutomationConversations, "read" | "run"> | undefined;
  transfer?: AutomationTransferServices | undefined;
  transferImport?: AutomationTransferImportServices | undefined;
  relocation?:
    | {
        schedule(parent: string): Promise<string>;
        cancel(): Promise<void>;
        assertReady(): void;
        restart(): void;
      }
    | undefined;
  legacyDrafts?: Pick<DraftService, "list" | "open"> & { isImported(id: string): Promise<boolean> };
  settings?: SettingsService;
  credentials?: AiCredentialVault | undefined;
  probeModel?:
    | ((
        action: "test" | "discover",
        profileId: string,
        signal: AbortSignal,
        assertAuthorized: () => void,
        beginRequest: () => void,
      ) => Promise<unknown>)
    | undefined;
  drawingRuntime?: string;
  onSettingsChanged?(saved: AppSettings, patch: AppSettingsPatch): void;
  gate?: DataTransferOperationGate;
};
const uuid = z.string().uuid();
const readSchema = z
  .object({
    patentId: uuid,
    persisted: z.boolean().optional(),
    sync: z.boolean().optional(),
    bookKind: z
      .enum(["claims", "description", "description-drawings", "abstract", "abstract-drawing"])
      .optional(),
    blockIds: z.array(uuid).max(5000).optional(),
  })
  .strict();
const inspectionSchema = readSchema.extend({
  mode: z.enum(["instant", "full"]).default("full"),
  ruleIds: z.array(z.string().min(1).max(120)).max(200).optional(),
});
const publicationCommands = new Set([
  "patent.export",
  "patent.export-bundle",
  "asset.export",
  "flowchart.export",
  "global.documents.export",
  "global.transfer.export",
]);
const hashProof = (proof: string) => createHash("sha256").update(proof).digest("hex");

export class AutomationHub {
  readonly instanceId = randomUUID();
  readonly libraryId: string;
  readonly ledger: AutomationLedger;
  readonly barrier: AutomationBarrier;
  readonly closer: AutomationPatentCloser;
  readonly docxImports: AutomationDocxImports;
  readonly transport: AutomationTransport;
  #enabled = false;
  #policyConsent: { policyAcceptedVersion: string; policyAcceptedAt: string } | undefined;
  #disposed = false;
  #databaseDetached = false;
  #handoffs = new Map<
    string,
    { grant: Grant; run: () => Promise<void>; cancel?: () => Promise<void> }
  >();
  readonly transferImports: AutomationTransferImports | undefined;
  #closing = false;
  #enableTransition: Promise<void> = Promise.resolve();
  #pairs = new Map<string, Pair>();
  #workspaceSelecting = new Set<string>();
  #grants = new Map<string, Grant>();
  #responseGrants = new WeakMap<AutomationRequest, Grant>();
  #changes = new Map<string, Prepared>();
  #stages = new Map<string, Stage>();
  #live = new Map<string, Live>();
  #guiMutations = new Map<string, number>();
  #gate: DataTransferOperationGate;
  #cleanupTimer: ReturnType<typeof setInterval>;
  #lastCleanupError: unknown;

  constructor(private readonly options: AutomationHubOptions) {
    this.#gate = options.gate ?? getDataTransferOperationGate();
    this.ledger = new AutomationLedger(options.runtime.database);
    this.libraryId = this.ledger.initializeLibraryId(options.runtime.readOnly);
    this.transferImports = options.transferImport
      ? new AutomationTransferImports(options.transferImport)
      : undefined;
    this.closer = new AutomationPatentCloser(options.participants);
    this.docxImports = new AutomationDocxImports(options.runtime);
    this.barrier = new AutomationBarrier(
      options.participants,
      8000,
      (id) => !this.#guiMutations.get(id),
    );
    this.transport = new AutomationTransport(
      options.home,
      {
        instanceId: this.instanceId,
        libraryId: this.libraryId,
        protocolVersion: AUTOMATION_PROTOCOL_VERSION,
        version: options.version,
        label: options.label,
        pid: process.pid,
      },
      (r) => this.execute(r),
      (request, value) => {
        const responseGrant = this.#responseGrants.get(request);
        if (responseGrant) this.#assertGrant(responseGrant);
        if (
          ["version", "capabilities", "doctor", "pair.begin", "pair.poll"].includes(request.command)
        ) {
          if (
            (request.command === "pair.begin" || request.command === "pair.poll") &&
            value &&
            typeof value === "object" &&
            "token" in value
          ) {
            const grant = this.#grants.get(String(value.token));
            if (!grant) throw new AutomationError("AUTH_REVOKED", "授权已失效。");
            this.#assertGrant(grant);
          }
          return;
        }
        const grant = this.#grant(request);
        if (value && typeof value === "object" && "operationId" in value) {
          const record = this.ledger.byId(grant.clientId, String(value.operationId));
          if (record) this.#assertRecordScope(grant, record);
        }
      },
      (request, value) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("operationId" in value) ||
          !("status" in value) ||
          value.status !== "committed"
        )
          return;
        const id = String(value.operationId);
        const handoff = this.#handoffs.get(id);
        if (!handoff || handoff.grant !== this.#responseGrants.get(request)) return;
        this.#handoffs.delete(id);
        void handoff.run().catch((error) => {
          this.#lastCleanupError = error;
        });
      },
    );
    this.#cleanupTimer = setInterval(() => {
      void this.cleanup().catch((e) => {
        this.#lastCleanupError = e;
      });
    }, 15000);
    this.#cleanupTimer.unref();
  }
  async initialize(): Promise<void> {
    if (!this.options.runtime.readOnly)
      await this.#gate.runMutation(IPC_CHANNELS.patentsCreate, () => this.#recover());
    let enabled = false;
    try {
      const parsed = z
        .object({
          enabled: z.boolean(),
          policyAcceptedVersion: z.string().optional(),
          policyAcceptedAt: z.string().datetime().optional(),
        })
        .strict()
        .safeParse(JSON.parse(await readFile(join(this.options.home, "preferences.json"), "utf8")));
      if (
        parsed.success &&
        parsed.data.policyAcceptedVersion === AGENT_CLI_POLICY_VERSION &&
        parsed.data.policyAcceptedAt
      ) {
        this.#policyConsent = {
          policyAcceptedVersion: parsed.data.policyAcceptedVersion,
          policyAcceptedAt: parsed.data.policyAcceptedAt,
        };
        enabled = parsed.data.enabled;
      }
    } catch (error) {
      // A torn or malformed preference is not authority to start the local service.
      // Keep the original file until an explicit toggle replaces it; filesystem failures still surface.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    if (enabled) {
      await this.transport.start();
      this.#enabled = true;
    }
  }
  state(): AutomationUiState {
    const descriptor = this.transport.descriptor;
    return {
      enabled: this.#enabled,
      instance: descriptor
        ? {
            instanceId: descriptor.instanceId,
            libraryId: descriptor.libraryId,
            endpoint: descriptor.endpoint,
            protocolVersion: AUTOMATION_PROTOCOL_VERSION,
            version: descriptor.version,
            label: descriptor.label,
            pid: descriptor.pid,
          }
        : null,
      pendingPairs: [...this.#pairs.values()]
        .filter(
          (p) => !p.grant && p.expiresAt > Date.now() && (!p.renewalGrant || p.renewalGrant.active),
        )
        .map(({ pairId, clientId, label, expiresAt, requested, renewalGrant }) => ({
          pairId,
          clientId,
          label,
          expiresAt,
          ...(requested ? { requested } : {}),
          ...(renewalGrant ? { creationRenewal: true } : {}),
        })),
      grants: [...this.#grants.values()]
        .filter((g) => g.active)
        .map((g) => ({
          grantId: g.grantId,
          clientId: g.clientId,
          label: g.label,
          scope: this.#scope(g),
          taskId: g.taskId,
          createdCount: this.#created(g).length,
          creationRemaining: this.#creationRemaining(g),
        })),
      changes: [...this.#changes.values()]
        .filter((c) => !c.applied && c.grant.active && c.expiresAt > Date.now())
        .map((c) => ({
          changeId: c.changeId,
          patentId: c.patentId,
          name: c.prepared.patent.name,
          clientLabel: c.grant.label,
          expectedRevision: c.expectedRevision,
          risk: c.prepared.risk,
          diff: c.prepared.diff,
          expiresAt: c.expiresAt,
        })),
      stagedAssetCount: this.#stages.size,
    };
  }
  changed(): void {
    this.options.broadcast({ type: "stateChanged" });
  }
  beginGuiMutation(patentId: string | undefined): () => void {
    this.barrier.guardWrite(patentId);
    if (!patentId) return () => {};
    this.#guiMutations.set(patentId, (this.#guiMutations.get(patentId) ?? 0) + 1);
    return () => {
      const count = (this.#guiMutations.get(patentId) ?? 1) - 1;
      if (count) this.#guiMutations.set(patentId, count);
      else this.#guiMutations.delete(patentId);
    };
  }
  async control(input: AutomationUiRequest, ownerId: number): Promise<unknown> {
    const request = AutomationUiRequestSchema.parse(input);
    if (request.action === "closeAck") {
      this.closer.acknowledge(ownerId, request);
      return null;
    }
    if (request.action === "barrierAck") {
      this.barrier.acknowledge(ownerId, request);
      return null;
    }
    if (request.action === "status") return this.state();
    if (request.action === "accessInstructions") {
      if (!this.#enabled || !this.options.accessInstructions)
        throw new AutomationError("AUTOMATION_DISABLED", "请先开启 Agent CLI。");
      const instructions = await this.options.accessInstructions(this.instanceId);
      if (!this.#enabled || this.#closing || this.#disposed)
        throw new AutomationError("AUTOMATION_DISABLED", "Agent CLI 已关闭。");
      return instructions;
    }
    if (request.action === "resync") {
      if (!this.options.participants(request.patentId).some((p) => p.ownerId === ownerId))
        throw new AutomationError("SCOPE_DENIED", "当前窗口没有该专利的编辑会话。");
      return this.#mutateRead(() =>
        this.options.runtime.patents.captureAutomation(request.patentId),
      );
    }
    if (request.action === "setEnabled") {
      if (request.enabled && request.policyAcceptedVersion !== AGENT_CLI_POLICY_VERSION)
        throw new AutomationError(
          "POLICY_CONSENT_REQUIRED",
          "请先阅读并同意当前 Agent CLI 使用协议与隐私说明。",
        );
      const transition = this.#enableTransition.then(() => this.#setEnabled(request.enabled));
      this.#enableTransition = transition.catch(() => undefined);
      await transition;
    } else if (request.action === "approvePair") {
      if (!this.#enabled) throw new AutomationError("AUTOMATION_DISABLED", "请先开启Agent CLI。");
      const pair = this.#pairs.get(request.pairId);
      if (!pair || pair.expiresAt <= Date.now())
        throw new AutomationError("PAIR_EXPIRED", "配对请求已过期。");
      if (pair.grant?.active) return this.state();
      if (pair.renewalGrant) {
        const grant = pair.renewalGrant;
        this.#assertGrant(grant);
        if (this.#closing || !request.scope.createLimit)
          throw new AutomationError("SCOPE_DENIED", "请开启本次新建授权。");
        AutomationScopeSchema.parse(request.scope);
        if (this.#creationRemaining(grant) === AUTOMATION_CREATE_BATCH)
          throw new AutomationError("INVALID_SCOPE", "刚获批的新建额度尚未使用。");
        // A renewal changes only the creation allowance. Task, token and patent authority remain intact.
        grant.creationBase = this.#created(grant).length;
        grant.scope = { ...grant.scope, createLimit: AUTOMATION_CREATE_BATCH };
        pair.grant = grant;
        this.changed();
        return this.state();
      }
      const taskId = randomUUID();
      const scope = await this.#resolveScope(request.scope, taskId);
      if (
        !this.#enabled ||
        this.#closing ||
        this.#pairs.get(pair.pairId) !== pair ||
        pair.expiresAt <= Date.now()
      )
        throw new AutomationError("PAIR_EXPIRED", "入口或配对状态已变化，请重新配对。");
      if (pair.grant?.active) return this.state();
      for (const g of this.#grants.values()) if (g.clientId === pair.clientId) this.#revoke(g);
      const grant: Grant = {
        grantId: randomUUID(),
        token: `${randomUUID()}${randomUUID()}`,
        clientId: pair.clientId,
        label: pair.label,
        scope,
        taskId,
        createdOverrides: new Set(),
        creationBase: 0,
        active: true,
      };
      pair.grant = grant;
      this.#grants.set(grant.token, grant);
    } else if (request.action === "rejectPair") this.#pairs.delete(request.pairId);
    else if (request.action === "revoke") {
      const grant = [...this.#grants.values()].find((g) => g.grantId === request.grantId);
      if (grant) this.#revoke(grant);
      await this.cleanup();
    } else if (request.action === "updateGrant") {
      const grant = [...this.#grants.values()].find(
        (g) => g.grantId === request.grantId && g.active,
      );
      if (!grant) throw new AutomationError("AUTH_REVOKED", "授权已失效。");
      const scope = await this.#resolveScope(request.scope, grant.taskId);
      this.#assertGrant(grant);
      if (this.#closing) throw new AutomationError("AUTH_REVOKED", "实例正在关闭。");
      // Replace the object so every in-flight operation and prepared plan retains the old, revoked authority.
      const replacement: Grant = {
        ...grant,
        scope,
        createdOverrides: new Set(this.#owned(grant)),
      };
      this.#revoke(grant);
      this.#grants.set(replacement.token, replacement);
      await this.cleanup();
    } else if (request.action === "discardChange") {
      const change = this.#changes.get(request.changeId);
      if (change && !change.applied) change.expiresAt = 0;
      await this.cleanup();
    } else if (request.action === "discardAssets") {
      for (const c of this.#changes.values())
        if (!c.applied && c.assetHandles.length) c.expiresAt = 0;
      for (const s of this.#stages.values()) s.expiresAt = 0;
      await this.cleanup();
    }
    this.changed();
    return this.state();
  }
  async #setEnabled(enabled: boolean): Promise<void> {
    if (this.#closing || this.#disposed)
      throw new AutomationError("AUTOMATION_DISABLED", "实例正在关闭。");
    const persist = (consent = this.#policyConsent) =>
      this.#gate.runMutation(IPC_CHANNELS.patentsFlush, async () => {
        await privateDirectory(this.options.home);
        await writeFileAtomic(
          join(this.options.home, "preferences.json"),
          JSON.stringify({ enabled, ...consent }),
          { mode: 0o600 },
        );
      });
    if (!enabled) {
      this.#enabled = false;
      this.#pairs.clear();
      for (const g of this.#grants.values()) this.#revoke(g);
      try {
        await persist();
      } finally {
        try {
          await this.cleanup();
        } finally {
          await this.transport.close();
          this.changed();
        }
      }
    } else {
      const wasEnabled = this.#enabled;
      await this.transport.start();
      const consent = {
        policyAcceptedVersion: AGENT_CLI_POLICY_VERSION,
        policyAcceptedAt: new Date().toISOString(),
      };
      try {
        await persist(consent);
      } catch (error) {
        if (!wasEnabled) await this.transport.close();
        throw error;
      }
      this.#policyConsent = consent;
      this.#enabled = true;
    }
  }
  async #resolveScope(input: AutomationScope, taskId: string): Promise<ResolvedAutomationScope> {
    const scope = AutomationScopeSchema.parse(input);
    const ids = new Set(
      (await this.#mutateRead(() => this.options.runtime.patents.list("active"))).map(
        (p) => p.patentId,
      ),
    );
    if (Object.keys(scope.patents).some((id) => !ids.has(id)))
      throw new AutomationError("INVALID_SCOPE", "授权范围包含不可用专利。");
    const root = join(this.options.home, "tasks", this.libraryId, taskId);
    const resolveDirectory = async (path: string | undefined, kind: string) =>
      path ? realpath(path) : privateDirectory(join(root, kind));
    const importDirectory = await resolveDirectory(scope.workspace.importDirectory, "materials");
    const exportDirectory = await resolveDirectory(scope.workspace.exportDirectory, "results");
    return {
      ...scope,
      createLimit: scope.createLimit ? AUTOMATION_CREATE_BATCH : 0,
      workspace: { importDirectory, exportDirectory },
    };
  }
  #created(grant: Grant): string[] {
    return this.ledger.createdForTask(grant.taskId, grant.clientId);
  }
  #creationLimit(grant: Grant): number {
    return grant.scope.createLimit ? grant.creationBase + AUTOMATION_CREATE_BATCH : 0;
  }
  #creationRemaining(grant: Grant): number {
    return Math.max(0, this.#creationLimit(grant) - this.#created(grant).length);
  }
  #creationScope(grant: Grant): ResolvedAutomationScope {
    return { ...grant.scope, createLimit: this.#creationLimit(grant) };
  }
  #owned(grant: Grant): string[] {
    return [...this.#created(grant), ...this.ledger.restoredForTask(grant.taskId, grant.clientId)];
  }
  #scope(grant: Grant, includeInactive = false): ResolvedAutomationScope {
    const patents = { ...grant.scope.patents };
    for (const id of this.#owned(grant)) if (!grant.createdOverrides.has(id)) patents[id] = "full";
    if (!includeInactive) {
      this.options.runtime.database.read((database) => {
        const active = database.prepare(
          "SELECT patent_id FROM patents WHERE patent_id = ? AND deleted_at IS NULL",
        );
        for (const id of Object.keys(patents)) if (!active.get(id)) delete patents[id];
      });
    }
    return { ...grant.scope, patents };
  }
  #pairReceipt(grant: Grant, request: AutomationRequest): unknown {
    this.#responseGrants.set(request, grant);
    return {
      status: "authorized",
      token: grant.token,
      clientId: grant.clientId,
      grantId: grant.grantId,
      taskId: grant.taskId,
      scope: this.#scope(grant),
      createdCount: this.#created(grant).length,
      creationRemaining: this.#creationRemaining(grant),
    };
  }
  #revoke(grant: Grant): void {
    grant.active = false;
    for (const live of this.#live.values()) if (live.grant === grant) live.controller.abort();
    for (const c of this.#changes.values()) if (c.grant === grant) c.expiresAt = 0;
    for (const s of this.#stages.values()) if (s.grant === grant) s.expiresAt = 0;
  }
  #assertWritable(): void {
    if (this.options.runtime.readOnly)
      throw new AutomationError("READ_ONLY_RECOVERY", "文档库处于只读恢复状态。");
  }
  #assertGrant(grant: Grant, patentId?: string, write = false, receiptOnly = false): void {
    const current = this.#grants.get(grant.token);
    if (current && current !== grant && current.active)
      throw new AutomationError("AUTH_CHANGED", "专利范围已调整，请读取当前授权后重试。");
    if (
      this.#disposed ||
      !this.#enabled ||
      !grant.active ||
      this.#grants.get(grant.token) !== grant
    )
      throw new AutomationError("AUTH_REVOKED", "授权已失效，请重新配对。");
    if (
      patentId &&
      !(write
        ? this.#scope(grant, receiptOnly).patents[patentId] === "full"
        : this.#scope(grant, receiptOnly).patents[patentId])
    )
      throw new AutomationError("SCOPE_DENIED", "专利不在授权范围内。");
  }
  #grant(request: AutomationRequest): Grant {
    const grant = request.token ? this.#grants.get(request.token) : undefined;
    if (!grant) throw new AutomationError("AUTH_REQUIRED", "请先配对并在软件中授权。");
    this.#assertGrant(grant);
    if (!request.clientProof || hashProof(request.clientProof) !== grant.clientId)
      throw new AutomationError("AUTH_REQUIRED", "客户端身份与授权不一致。");
    return grant;
  }
  async execute(request: AutomationRequest): Promise<unknown> {
    this.#responseGrants.delete(request);
    if (!this.#enabled) throw new AutomationError("AUTOMATION_DISABLED", "自动化入口已关闭。");
    if (request.command === "version")
      return { version: this.options.version, protocolVersion: AUTOMATION_PROTOCOL_VERSION };
    if (request.command === "capabilities")
      return {
        commands: AUTOMATION_COMMANDS.filter(
          (command) => command !== "patent.restore" && command !== "patent.delete",
        ),
        creationQuota: {
          batchSize: AUTOMATION_CREATE_BATCH,
          renewalCommand: "pair.renew-create",
          pollCommand: "pair.poll",
          pollBy: "id",
        },
        platformSupport: {
          transferImportCommit: this.options.transferImport?.supportsCommit !== false,
        },
        operationSchema: z.toJSONSchema(AutomationOperationsSchema),
        inspectionRules: DEFAULT_PATENT_INSPECTION_RULES.map(
          ({ inspect: _inspect, appliesTo: _appliesTo, ...metadata }) => metadata,
        ),
        inputSchema: {
          authorizationRequest: z.toJSONSchema(AutomationAuthorizationRequestSchema),
          workspaceSelection: z.toJSONSchema(AutomationWorkspaceSelectionSchema),
          inspection: z.toJSONSchema(inspectionSchema),
          drawingImport: z.toJSONSchema(AutomationDrawingImportSchema),
          drawingRender: z.toJSONSchema(AutomationDrawingRenderSchema),
          patentImport: z.toJSONSchema(AutomationPatentImportSchema),
          bundleExport: z.toJSONSchema(AutomationBundleExportSchema),
          patentPrint: z.toJSONSchema(AutomationPrintSchema),
          backupConfigure: z.toJSONSchema(AutomationBackupConfigureSchema),
          backupRead: z.toJSONSchema(AutomationBackupReadSchema),
          backupRun: z.toJSONSchema(AutomationBackupRunSchema),
          backupDelete: z.toJSONSchema(AutomationBackupDeleteSchema),
          backupRestore: z.toJSONSchema(AutomationBackupDeleteSchema),
          documents: Object.fromEntries(
            Object.entries(documentSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
          ),
          snapshotConfigure: z.toJSONSchema(AutomationSnapshotConfigureSchema),
          docxPrepare: z.toJSONSchema(AutomationDocxPrepareSchema),
          docxCommit: z.toJSONSchema(AutomationDocxCommitSchema),
          docxSession: z.toJSONSchema(AutomationDocxSessionSchema),
          docxAsset: z.toJSONSchema(AutomationDocxAssetSchema),
          snapshotCreate: z.toJSONSchema(AutomationSnapshotCreateSchema),
          snapshotDelete: z.toJSONSchema(AutomationSnapshotDeleteSchema),
          patentTrash: z.toJSONSchema(AutomationTrashSchema),
          patentTrashItem: z.toJSONSchema(AutomationTrashItemSchema),
          formulaRender: z.toJSONSchema(AutomationFormulaSchema),
          chemicalRender: z.toJSONSchema(AutomationChemicalSchema),
          assetExport: z.toJSONSchema(AutomationAssetExportSchema),
          legacyDraftRead: z.toJSONSchema(documentSchemas.AutomationLegacyReadSchema),
          legacyDraftImport: z.toJSONSchema(documentSchemas.AutomationLegacyImportSchema),
          transferRelocate: z.toJSONSchema(AutomationRelocateSchema),
          modelProbe: z.toJSONSchema(AutomationModelProbeSchema),
          transferRead: z.toJSONSchema(AutomationTransferReadSchema),
          transferExport: z.toJSONSchema(AutomationTransferExportSchema),
          transferImportPrepare: z.toJSONSchema(AutomationTransferPrepareSchema),
          transferImport: z.toJSONSchema(AutomationTransferImportSchema),
          transferImportCommit: z.toJSONSchema(AutomationTransferCommitSchema),
          conversationRead: z.toJSONSchema(AutomationConversationReadSchema),
          conversationRun: z.toJSONSchema(AutomationConversationRunSchema),
          flowchartRender: z.toJSONSchema(AutomationFlowchartRenderSchema),
          flowchartExport: z.toJSONSchema(AutomationFlowchartExportSchema),
          aiCorrection: z.toJSONSchema(AutomationCorrectionSchema),
          aiPolish: z.toJSONSchema(AutomationPolishSchema),
          modelSettingsPatch: z.toJSONSchema(AutomationModelsPatchSchema, { io: "output" }),
          search: z.toJSONSchema(AutomationSearchSchema),
          flowchartWrite: z.toJSONSchema(AutomationFlowchartWriteSchema),
          scope: z.toJSONSchema(AutomationScopeSchema),
          generalSettingsPatch: z.toJSONSchema(AutomationGeneralSettingsPatchSchema),
          templateUpdate: z.toJSONSchema(
            PatentTemplateEditorSaveRequestSchema.omit({ sessionId: true }),
          ),
        },
        limitations: [
          "运行中连接",
          "不覆盖已有输出",
          "整库导入最终原子切换支持Windows和macOS，以platformSupport为准；文档库搬迁与导入均须重启后核对完成状态",
          "回收站未满24小时不能永久删除",
        ],
        leaseMs: AUTOMATION_LEASE_MS,
      };
    if (request.command === "doctor") {
      let grant: Grant | undefined;
      try {
        grant = this.#grant(request);
        this.#responseGrants.set(request, grant);
      } catch {
        /* Discovery stays available without authorization. */
      }
      return {
        running: true,
        instanceId: this.instanceId,
        libraryId: this.libraryId,
        readOnly: this.options.runtime.readOnly,
        cleanupPending: Boolean(this.#lastCleanupError),
        authorized: Boolean(grant),
        ...(grant
          ? {
              scope: this.#scope(grant),
              taskId: grant.taskId,
              createdCount: this.#created(grant).length,
              creationRemaining: this.#creationRemaining(grant),
            }
          : {}),
      };
    }
    if (request.command === "pair.begin" || request.command === "pair.poll") {
      if (!request.clientProof)
        throw new AutomationError("AUTH_REQUIRED", "缺少本机客户端身份证明。");
      for (const [id, old] of this.#pairs)
        if (
          old.expiresAt <= Date.now() ||
          old.grant?.active === false ||
          old.renewalGrant?.active === false
        )
          this.#pairs.delete(id);
      const clientId = hashProof(request.clientProof);
      if (request.command === "pair.poll" && request.payload.id !== undefined) {
        const pair = this.#pairs.get(z.string().uuid().parse(request.payload.id));
        if (!pair || pair.clientId !== clientId || pair.expiresAt <= Date.now())
          throw new AutomationError("PAIR_EXPIRED", "授权请求已拒绝或到期，请停止等待。");
        if (pair.grant?.active) return this.#pairReceipt(pair.grant, request);
        if (pair.renewalGrant) this.#assertGrant(pair.renewalGrant);
        return { status: "pending", pairId: pair.pairId, expiresAt: pair.expiresAt };
      }
      const activeGrant = [...this.#grants.values()].find(
        (g) => g.clientId === clientId && g.active,
      );
      if (activeGrant) return this.#pairReceipt(activeGrant, request);
      let pair = [...this.#pairs.values()].find(
        (p) => p.clientId === clientId && p.expiresAt > Date.now(),
      );
      if (!pair) {
        if (request.command === "pair.poll")
          throw new AutomationError("PAIR_EXPIRED", "请重新申请配对。");
        if (this.#pairs.size > 100)
          throw new AutomationError("TOO_MANY_REQUESTS", "配对请求过多。");
        pair = {
          pairId: randomUUID(),
          clientId,
          label: z
            .string()
            .min(1)
            .max(80)
            .parse(request.payload.label ?? "本地 AI agent"),
          expiresAt: Date.now() + AUTOMATION_LEASE_MS,
          ...(request.payload.requested
            ? { requested: AutomationAuthorizationRequestSchema.parse(request.payload.requested) }
            : {}),
        };
        this.#pairs.set(pair.pairId, pair);
        this.changed();
      }
      if (pair.grant?.active) return this.#pairReceipt(pair.grant, request);
      return {
        status: "pending",
        pairId: pair.pairId,
        clientId,
        expiresAt: pair.expiresAt,
        nextAction: "请处理软件中央的授权弹窗，批准后再执行 connect。",
      };
    }
    const grant = this.#grant(request);
    this.#responseGrants.set(request, grant);
    const value = await this.#executeGranted(request, grant);
    this.#assertGrant(grant);
    return value;
  }
  async #executeGranted(request: AutomationRequest, grant: Grant): Promise<unknown> {
    const p = request.payload;
    if (request.command === "pair.renew-create") {
      if (this.#closing) throw new AutomationError("APP_CLOSING", "软件正在关闭。");
      if (!grant.scope.createLimit)
        throw new AutomationError("SCOPE_DENIED", "未授权新建专利，不能续授权。");
      if (this.#creationRemaining(grant) === AUTOMATION_CREATE_BATCH)
        throw new AutomationError("INVALID_SCOPE", "刚获批的新建额度尚未使用，无需重复申请。");
      let pair = [...this.#pairs.values()].find(
        (item) => item.renewalGrant === grant && !item.grant && item.expiresAt > Date.now(),
      );
      if (!pair) {
        if (this.#pairs.size > 100)
          throw new AutomationError("TOO_MANY_REQUESTS", "授权请求过多。");
        pair = {
          pairId: randomUUID(),
          clientId: grant.clientId,
          label: grant.label,
          expiresAt: Date.now() + AUTOMATION_LEASE_MS,
          renewalGrant: grant,
        };
        this.#pairs.set(pair.pairId, pair);
        this.changed();
      }
      return {
        status: "pending",
        pairId: pair.pairId,
        expiresAt: pair.expiresAt,
        nextAction: `请在软件中确认新建授权；使用 pair poll --id ${pair.pairId} 查询此请求，不要重复申请。`,
      };
    }
    if (request.command === "workspace.select") {
      if (this.#closing) throw new AutomationError("APP_CLOSING", "软件正在关闭，不能选择位置。");
      const input = AutomationWorkspaceSelectionSchema.parse(p);
      if (!this.options.chooseWorkspace)
        throw new AutomationError("UNAVAILABLE", "此实例不支持位置选择。");
      const busy = () => [...this.#live.values()].some((operation) => operation.grant === grant);
      if (this.#workspaceSelecting.has(grant.clientId) || busy())
        throw new AutomationError("BUSY", "请先完成正在进行的任务或位置选择。");
      this.#workspaceSelecting.add(grant.clientId);
      try {
        const selected = await this.options.chooseWorkspace(
          input.kind,
          input.directory,
          grant.label,
        );
        this.#assertGrant(grant);
        if (this.#closing) throw new AutomationError("APP_CLOSING", "软件正在关闭，不能更改位置。");
        if (!selected) return { status: "cancelled", kind: input.kind };
        if (busy()) throw new AutomationError("BUSY", "任务正在执行，请完成后重新选择位置。");
        const directory = await realpath(selected);
        if (!(await stat(directory)).isDirectory())
          throw new AutomationError("INVALID_INPUT", "请选择文件夹。");
        this.#assertGrant(grant);
        if (this.#closing) throw new AutomationError("APP_CLOSING", "软件正在关闭，不能更改位置。");
        if (busy()) throw new AutomationError("BUSY", "任务正在执行，请完成后重新选择位置。");
        grant.scope = {
          ...grant.scope,
          workspace: {
            ...grant.scope.workspace,
            [input.kind === "import" ? "importDirectory" : "exportDirectory"]: directory,
          },
        };
        this.changed();
        return { status: "selected", kind: input.kind, directory, scope: this.#scope(grant) };
      } finally {
        this.#workspaceSelecting.delete(grant.clientId);
      }
    }
    if (request.command === "patent.restore" || request.command === "patent.delete")
      throw new AutomationError(
        "SCOPE_DENIED",
        "回收站专利不能通过 Agent 操作，请先在软件中恢复。",
      );
    const globalDomain = commandGlobalDomain(request.command);
    if (globalDomain) return this.#executeGlobal(request, grant, globalDomain);
    if (request.command.startsWith("docx.")) {
      if (!grant.scope.createLimit)
        throw new AutomationError("SCOPE_DENIED", "未授权新建导入专利。");
      const context = {
        grantId: grant.grantId,
        grant: this.#creationScope(grant),
        taskId: grant.taskId,
        clientId: grant.clientId,
        assertAuthorized: () => this.#assertGrant(grant),
      };
      if (request.command === "docx.prepare") {
        const input = AutomationDocxPrepareSchema.parse(p);
        if (this.#creationRemaining(grant) === 0)
          throw new AutomationError(
            "SCOPE_DENIED",
            "本次新建额度已用完；请执行 pair renew-create 请求用户再次授权，每次最多 5 件。",
          );
        return this.#mutate(() => this.docxImports.prepare(input.paths, context));
      }
      if (request.command === "docx.commit") {
        const input = AutomationDocxCommitSchema.parse(p);
        return this.#operate(request, grant, [], async (record, signal) => {
          const saved = await this.docxImports.commit(input, {
            ...context,
            record,
            ledger: this.ledger,
            assertAuthorized: () => {
              this.#assertGrant(grant);
              this.#assertNotCancelled(signal);
            },
          });
          this.changed();
          return saved;
        });
      }
      if (request.command === "docx.preview-asset") {
        const input = AutomationDocxAssetSchema.parse(p);
        return this.#mutateRead(() =>
          this.docxImports.asset(input.sessionId, input.assetId, grant.grantId),
        );
      }
      const input = AutomationDocxSessionSchema.parse(p);
      if (request.command === "docx.discard")
        return this.#mutate(() => this.docxImports.discard(input.sessionId, grant.grantId));
      return this.docxImports.preview(input.sessionId, grant.grantId);
    }
    if (request.command === "manual")
      return { markdown: await this.options.manual(), version: this.options.version };
    if (request.command === "template.list")
      return this.#mutateRead(() => {
        const catalog = this.options.runtime.patentTemplates.readSummary();
        return {
          revision: catalog.revision,
          separatePatentTypes: catalog.separatePatentTypes,
          ...Object.fromEntries(
            (["invention", "utility-model"] as const).map((type) => [
              type,
              {
                selection: catalog[type].selection,
                slots: catalog[type].slots.map(
                  ({ claims, description, abstract, ...metadata }) => ({
                    ...metadata,
                    hasContent: Boolean(claims && description && abstract),
                  }),
                ),
              },
            ]),
          ),
        };
      });
    if (request.command === "template.describe") {
      const type = z.enum(["invention", "utility-model"]).parse(p.patentType);
      const source = await this.#mutateRead(() =>
        this.options.runtime.patentTemplates.resolveCreationSource(type),
      );
      // Describe structure/fields only; private template assets are not a generic asset read API.
      return {
        patentType: type,
        kind: source.kind,
        templateId: source.templateId,
        slots: Object.entries(source.templates).map(([slot, template]) => {
          const collectText = (value: unknown): string => {
            if (Array.isArray(value)) return value.map(collectText).join("");
            if (value && typeof value === "object") {
              if ("type" in value && value.type === "text" && "text" in value)
                return String(value.text);
              return Object.values(value).map(collectText).join("");
            }
            return "";
          };
          const text = collectText(template);
          return {
            slot,
            fields: Object.entries(PATENT_TEMPLATE_TOKENS)
              .filter(([, token]) => text.includes(token))
              .map(([field]) => field),
          };
        }),
      };
    }
    if (request.command === "patent.search") {
      const input = AutomationSearchSchema.parse(p);
      const scope = this.#scope(grant).patents;
      const requested = input.patentIds ?? Object.keys(scope);
      for (const id of requested) this.#assertGrant(grant, id);
      return this.#mutateRead(async () => {
        const active = new Set(
          (await this.options.runtime.patents.list("active")).map((item) => item.patentId),
        );
        const matches: AutomationSearchMatch[] = [];
        for (const id of new Set(requested)) {
          if (!active.has(id)) continue;
          this.#assertGrant(grant, id);
          const patent = await this.options.runtime.patents.captureAutomation(id);
          matches.push(
            ...searchPatent(
              patent,
              input.query,
              input.caseSensitive,
              input.limit + 1 - matches.length,
            ),
          );
          if (matches.length > input.limit) break;
        }
        this.#assertGrant(grant);
        return {
          items: matches.slice(0, input.limit),
          hasMore: matches.length > input.limit,
          persisted: true,
        };
      });
    }
    if (request.command === "patent.list") {
      const scope = z.enum(["active", "trash"]).parse(p.scope ?? "active");
      const offset = z
        .number()
        .int()
        .min(0)
        .parse(p.offset ?? 0);
      const limit = z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(p.limit ?? 50);
      const readable = this.#scope(grant).patents;
      const all = (await this.#mutateRead(() => this.options.runtime.patents.list(scope))).filter(
        (patent) => readable[patent.patentId],
      );
      this.#assertGrant(grant);
      return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
    }
    if (request.command === "operation.status" || request.command === "operation.cancel") {
      const locator = z
        .union([
          z.object({ id: uuid }).strict(),
          z
            .object({ requestId: z.string().min(1).max(128), command: z.string().min(1).max(80) })
            .strict(),
        ])
        .parse(p);
      const record =
        "id" in locator
          ? this.ledger.byId(grant.clientId, locator.id)
          : this.ledger.read(grant.clientId, locator.command, locator.requestId);
      if (!record) return { status: "not_received" };
      this.#assertRecordScope(grant, record);
      if (request.command === "operation.cancel") {
        const domain = commandGlobalDomain(record.command);
        if (domain) this.#assertGlobal(grant, domain, true);
        for (const id of record.target.patentIds) this.#assertGrant(grant, id, true);
      }
      if (request.command === "operation.cancel") {
        const live = this.#live.get(record.operationId);
        if (record.status === "committed")
          return { status: "alreadyCommitted", operationId: record.operationId };
        if (live) {
          live.controller.abort();
          return { status: "cancelRequested", operationId: record.operationId };
        }
      }
      const publicationDomain = commandGlobalDomain(record.command);
      if (
        request.command === "operation.status" &&
        publicationCommands.has(record.command) &&
        record.evidence &&
        record.status === "recovery_required" &&
        !this.options.runtime.readOnly &&
        (!publicationDomain || grant.scope.global?.[publicationDomain] === "full") &&
        record.target.patentIds.every((id) => this.#scope(grant).patents[id] === "full")
      ) {
        await this.#mutate(() =>
          recoverPublication(this.ledger, record, [grant.scope.workspace.exportDirectory], () =>
            this.#assertRecordScope(grant, record),
          ),
        );
      }
      return this.#receipt(record);
    }
    if (request.command === "change.inspect" || request.command === "change.discard") {
      const id = uuid.parse(p.changeId);
      const change = this.#requireChange(id, grant);
      this.#assertGrant(grant, change.patentId, true);
      if (request.command === "change.discard") {
        await this.#mutate(() => {
          change.expiresAt = 0;
        });
        await this.cleanup();
        this.changed();
        return { changeId: id, discarded: true };
      }
      return this.#changeReceipt(change);
    }
    if (request.command === "asset.preview") {
      const input = z.object({ assetHandle: uuid }).strict().parse(p);
      const stage = this.#stages.get(input.assetHandle);
      if (!stage || stage.grant !== grant || stage.expiresAt <= Date.now())
        throw new AutomationError("NOT_FOUND", "暂存素材不可用。");
      this.#assertGrant(grant, stage.patentId, true);
      return this.#mutateRead(async () => {
        const stored = await this.options.runtime.assetStore.readAsset(stage.descriptor.assetId);
        this.#assertGrant(grant, stage.patentId, true);
        if (stage.expiresAt <= Date.now())
          throw new AutomationError("NOT_FOUND", "暂存素材已过期。");
        if (stored.preview.byteLength > Math.floor(MAX_AUTOMATION_FRAME * 0.7))
          throw new AutomationError("RESULT_TOO_LARGE", "预览素材过大。");
        return {
          descriptor: stored.descriptor,
          encoding: "base64",
          data: Buffer.from(stored.preview).toString("base64"),
        };
      });
    }
    if (request.command === "asset.discard") {
      const handle = uuid.parse(p.assetHandle);
      const stage = this.#stages.get(handle);
      if (!stage || stage.grant !== grant)
        throw new AutomationError("NOT_FOUND", "暂存素材不可用。");
      this.#assertGrant(grant, stage.patentId, true);
      if (stage.plans.size) throw new AutomationError("ASSET_IN_USE", "请先放弃使用该素材的方案。");
      await this.#mutate(() => {
        stage.expiresAt = 0;
      });
      await this.cleanup();
      this.changed();
      return { discarded: true };
    }
    if (
      (request.command === "patent.create" || request.command === "patent.import") &&
      grant.scope.createLimit === 0
    )
      throw new AutomationError("SCOPE_DENIED", "未授权新建专利。");
    if (request.command === "patent.export-bundle") {
      const input = AutomationBundleExportSchema.parse(p);
      const ids = input.patents.map((item) => item.patentId);
      // Check the complete cohort before reading even the first patent.
      for (const id of ids) this.#assertGrant(grant, id, true);
      return this.#operate(
        request,
        grant,
        ids,
        async (record, signal) => {
          const patents: CanonicalPatent[] = [];
          const assertAuthorized = () => {
            this.#assertNotCancelled(signal);
            for (const id of ids) this.#assertGrant(grant, id, true);
          };
          for (const item of input.patents) {
            assertAuthorized();
            const patent = await this.#readCurrent(
              grant,
              { patentId: item.patentId, persisted: input.persisted },
              true,
            );
            if (patent.revision !== item.expectedRevision)
              throw new AutomationError("REVISION_CONFLICT", "专利包中的专利版本已变化。");
            patents.push(patent);
          }
          return exportAutomationBundle(
            this.options.runtime,
            this.options.home,
            patents,
            input,
            {
              signal,
              record,
              ledger: this.ledger,
              grant: grant.scope,
              assertAuthorized,
            },
            this.options.renderPdf,
          );
        },
        true,
        true,
      );
    }
    if (request.command === "patent.import") {
      const input = AutomationPatentImportSchema.parse(p);
      return this.#operate(
        request,
        grant,
        [],
        async (record, signal) => {
          const result = await importAutomationPatents(
            this.options.runtime,
            this.options.home,
            input,
            {
              grant: this.#creationScope(grant),
              taskId: grant.taskId,
              record,
              ledger: this.ledger,
              assertAuthorized: () => {
                this.#assertGrant(grant);
                this.#assertNotCancelled(signal);
              },
            },
          );
          this.changed();
          return result;
        },
        true,
        true,
      );
    }
    if (request.command === "patent.create")
      return this.#operate(request, grant, [], async (record, signal) => {
        const input = z
          .object({
            patentType: z.enum(["invention", "utility-model"]),
            name: z.string().min(1).max(300),
            customer: z.string().max(300).optional(),
          })
          .strict()
          .parse(p);
        if (this.#creationRemaining(grant) === 0)
          throw new AutomationError(
            "SCOPE_DENIED",
            "本次新建额度已用完；请执行 pair renew-create 请求用户再次授权，每次最多 5 件。",
          );
        const source = this.options.runtime.patentTemplates.resolveCreationSource(input.patentType);
        const templates = createFactoryPatentTemplates(randomUUID);
        templates.enabled = source.kind !== "blank";
        templates[input.patentType] = structuredClone(source.templates);
        const opened = await this.options.runtime.patents.create({
          ...input,
          templates,
          templateAssetIds: source.assetIds,
          beforeCommit: () => {
            this.#assertGrant(grant);
            this.#assertNotCancelled(signal);
          },
          inTransaction: (d, patent) => {
            this.ledger.recordCreated(
              d,
              grant.taskId,
              grant.clientId,
              patent.patentId,
              this.#creationLimit(grant),
            );
            const committedRecord = { ...record, target: { patentIds: [patent.patentId] } };
            this.ledger.inTransaction(d, committedRecord, "committed", {
              patentId: patent.patentId,
              revision: patent.revision,
            });
          },
        });
        await this.options.runtime.patents.release(opened.sessionId);
        this.changed();
        return { patentId: opened.patentId, revision: opened.patent.revision };
      });
    const patentId = uuid.parse(p.patentId);
    const write = [
      "ai.correct",
      "ai.polish",
      "ai.conversation.run",
      "flowchart.write",
      "history.create",
      "history.delete",
      "change.prepare",
      "change.restore-prepare",
      "change.apply",
      "asset.import",
      "drawing.import",
      "drawing.render",
      "flowchart.render",
      "asset.render-formula",
      "asset.render-chemistry",
      "asset.export",
      "flowchart.export",
      "patent.export",
      "patent.print",
      "patent.printers",
      "patent.sync",
      "patent.show",
      "patent.close",
      "patent.trash",
      "patent.restore",
      "patent.delete",
    ].includes(request.command);
    this.#assertGrant(grant, patentId, write);
    if (write && this.closer.isBusy(patentId))
      throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在保存并关闭。");
    if (request.command === "patent.printers") {
      z.object({ patentId: uuid }).strict().parse(p);
      if (!this.options.printing) throw new AutomationError("UNAVAILABLE", "打印服务不可用。");
      const printers = await this.#mutateRead(() => this.options.printing!.printers());
      this.#assertGrant(grant, patentId, true);
      return { printers };
    }
    if (request.command === "patent.print") {
      const input = AutomationPrintSchema.parse(p);
      const printing = this.options.printing;
      if (!printing) throw new AutomationError("UNAVAILABLE", "打印服务不可用。");
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const patent = await this.#readCurrent(
            grant,
            { patentId, persisted: input.persisted },
            true,
          );
          if (patent.revision !== input.expectedRevision)
            throw new AutomationError("REVISION_CONFLICT", "打印版本已变化。");
          return printAutomationPatent(this.options.runtime, patent, input, printing, {
            signal,
            record,
            ledger: this.ledger,
            grant: grant.scope,
            assertAuthorized: () => {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
            },
          });
        },
        true,
        true,
      );
    }
    if (request.command === "ai.conversation.read") {
      AutomationConversationReadSchema.parse(p);
      const service = this.options.conversations;
      if (!service) throw new AutomationError("UNAVAILABLE", "AI 对话服务不可用。");
      return this.#mutateRead(async () => {
        this.#assertGrant(grant, patentId);
        const result = service.read(p);
        this.#assertGrant(grant, patentId);
        return result;
      });
    }
    if (request.command === "ai.conversation.run") {
      const input = AutomationConversationRunSchema.parse(p);
      const service = this.options.conversations;
      if (!service) throw new AutomationError("UNAVAILABLE", "AI 对话服务不可用。");
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const patent = await this.#readCurrent(
            grant,
            { patentId, persisted: input.persisted },
            true,
          );
          const assertAuthorized = () => {
            this.#assertGrant(grant, patentId, true);
            this.#assertNotCancelled(signal);
          };
          return service.run(patent, p, {
            operationId: record.operationId,
            signal,
            assertAuthorized,
            begin: () => {
              assertAuthorized();
              this.ledger.update(record, "running", null, {
                kind: "ai-conversation",
                action: input.action,
                ...("conversationId" in input ? { conversationId: input.conversationId } : {}),
              });
            },
            progress: (progress) => {
              assertAuthorized();
              this.ledger.update(record, "running", { progress });
            },
          });
        },
        true,
        true,
      );
    }
    if (request.command === "ai.correct" || request.command === "ai.polish") {
      const command = request.command;
      const input = (
        command === "ai.correct" ? AutomationCorrectionSchema : AutomationPolishSchema
      ).parse(p);
      const run = this.options.runAi;
      if (!run) throw new AutomationError("UNAVAILABLE", "当前实例的 AI 服务不可用。");
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const patent = await this.#readCurrent(
            grant,
            { patentId, ...(input.persisted === true ? { persisted: true } : {}) },
            true,
          );
          if (patent.revision !== input.expectedRevision)
            throw new AutomationError(
              "REVISION_CONFLICT",
              "专利已更新，请重新读取后发起 AI 任务。",
            );
          return run(command, patent, p, {
            signal,
            assertAuthorized: () => {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
            },
            progress: (progress) => {
              if (signal.aborted) return;
              try {
                this.#assertGrant(grant, patentId, true);
                this.ledger.update(record, "running", { progress });
              } catch {
                /* Revocation aborts this task; retain its last authorized progress. */
              }
            },
          });
        },
        true,
        true,
      );
    }
    if (request.command === "flowchart.list" || request.command === "flowchart.read") {
      return this.#mutateRead(async () => {
        // Check that the patent is still active before exposing its retained source data.
        await this.options.runtime.patents.captureAutomation(patentId);
        this.#assertGrant(grant, patentId);
        if (request.command === "flowchart.list")
          return { items: this.options.runtime.flowcharts.list(patentId) };
        const loaded = this.options.runtime.flowcharts.load(patentId, uuid.parse(p.projectId));
        return { ...loaded, source: Buffer.from(loaded.source).toString("utf8") };
      });
    }
    if (request.command === "flowchart.write") {
      const input = AutomationFlowchartWriteSchema.parse(p);
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const lock = await this.barrier.acquire(patentId);
          try {
            let committed: CanonicalPatent | undefined;
            await this.#mutate(async () => {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
              lock.assertValid();
              const current = await this.options.runtime.patents.captureAutomation(patentId);
              if (current.revision !== input.expectedRevision)
                throw new AutomationError("REVISION_CONFLICT", "专利已更新，请重新读取。");
              await this.options.runtime.snapshots.create(patentId, "manual-create");
              const context: FlowchartCommitContext = {
                beforeCommit: () => {
                  this.#assertGrant(grant, patentId, true);
                  this.#assertNotCancelled(signal);
                  lock.assertValid();
                },
                inTransaction: (database, patent) => {
                  committed = structuredClone(patent);
                  this.ledger.inTransaction(database, record, "committed", {
                    patentId,
                    revision: patent.revision,
                    projects: patent.flowchartProjects,
                    uiSync: "pending",
                  });
                },
              };
              const service = this.options.runtime.flowcharts;
              const target = { patentId, expectedPatentRevision: input.expectedRevision };
              if (
                input.action === "create" ||
                input.action === "save" ||
                input.action === "import"
              ) {
                const source = new FlowchartImportService().parse({
                  name: input.action === "import" ? basename(input.path) : "source.drawio",
                  bytes:
                    input.action === "import"
                      ? await readAllowedFile(
                          input.path,
                          [grant.scope.workspace.importDirectory],
                          FLOWCHART_MAX_SOURCE_XML_BYTES,
                        )
                      : Buffer.from(input.source, "utf8"),
                });
                if (input.action === "create" || input.action === "import")
                  await service.create(
                    {
                      ...target,
                      name: input.name ?? source.name,
                      source: source.source,
                      pageCount: source.pageCount,
                      lastPageId: source.lastPageId,
                    },
                    context,
                  );
                else
                  await service.save(
                    {
                      ...target,
                      projectId: input.projectId,
                      expectedProjectRevision: input.expectedProjectRevision,
                      source: source.source,
                      pageCount: source.pageCount,
                      lastPageId: source.lastPageId,
                    },
                    context,
                  );
              } else if (input.action === "rename")
                await service.rename(
                  {
                    ...target,
                    projectId: input.projectId,
                    expectedProjectRevision: input.expectedProjectRevision,
                    name: input.name,
                  },
                  context,
                );
              else if (input.action === "duplicate")
                await service.duplicate(
                  { ...target, projectId: input.projectId, name: input.name },
                  context,
                );
              else await service.delete({ ...target, projectId: input.projectId }, context);
            });
            if (!committed) throw new AutomationError("INTERNAL", "流程图提交回执缺失。");
            lock.markCommitted();
            const synced = await lock.adopt(committed);
            return {
              patentId,
              revision: committed.revision,
              projects: committed.flowchartProjects,
              uiSync: synced ? "confirmed" : "failed",
            };
          } finally {
            lock.release();
          }
        },
        false,
      );
    }
    if (request.command === "patent.sync") {
      this.#assertWritable();
      const lock = await this.barrier.acquire(patentId);
      try {
        return {
          patentId,
          revision: (
            await this.#mutateRead(() => this.options.runtime.patents.captureAutomation(patentId))
          ).revision,
        };
      } finally {
        lock.release();
      }
    }
    if (request.command === "patent.trash") {
      const command = request.command;
      const input = AutomationTrashSchema.parse(p);
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          if (this.barrier.isLocked(patentId))
            throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在同步。");
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          await this.closer.close(patentId, signal);
          return this.#mutate(async () => {
            let result: Record<string, unknown> = { patentId, action: command };
            const context: PatentLifecycleContext = {
              expectedRevision: input.expectedRevision,
              beforeCommit: () => {
                this.#assertGrant(grant, patentId, true);
                this.#assertNotCancelled(signal);
                if (this.barrier.isLocked(patentId) || this.closer.isBusy(patentId))
                  throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在同步或关闭。");
              },
              inTransaction: (database) => {
                const row = database
                  .prepare(
                    "SELECT revision, deleted_at AS deletedAt FROM patents WHERE patent_id = ?",
                  )
                  .get(patentId);
                result = {
                  patentId,
                  action: command,
                  ...(row ?? {}),
                };
                this.ledger.inTransaction(database, record, "committed", result);
              },
            };
            const current = await this.options.runtime.patents.captureAutomation(patentId);
            if (current.revision !== input.expectedRevision)
              throw new AutomationError(
                "REVISION_CONFLICT",
                "关闭保存后专利版本已变化，请重新读取。",
              );
            await this.options.runtime.snapshots.create(patentId, "manual-create", {
              beforeCommit: () => context.beforeCommit?.(),
            });
            await this.options.runtime.patents.moveToTrash(patentId, context);
            this.changed();
            return result;
          });
        },
        false,
      );
    }
    if (request.command === "patent.close") {
      z.object({ patentId: uuid }).strict().parse(p);
      return this.#operate(
        request,
        grant,
        [patentId],
        async (_record, signal) => {
          if (this.barrier.isLocked(patentId))
            throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在同步，请稍后关闭。");
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          await this.closer.close(patentId, signal);
          return { patentId, closed: true };
        },
        false,
      );
    }
    if (request.command === "patent.show") {
      this.options.broadcast({ type: "show", patentId });
      return { shown: true };
    }
    if (request.command === "asset.export" || request.command === "flowchart.export") {
      const input =
        request.command === "asset.export"
          ? AutomationAssetExportSchema.parse(p)
          : AutomationFlowchartExportSchema.parse(p);
      return this.#operate(request, grant, [patentId], async (record, signal) => {
        const patent = await this.#readCurrent(
          grant,
          { patentId, ...(input.persisted === true ? { persisted: true } : {}) },
          true,
        );
        if (patent.revision !== input.expectedRevision)
          throw new AutomationError("REVISION_CONFLICT", "输出版本已变化。");
        let bytes: Uint8Array;
        let format: string;
        if ("assetId" in input) {
          const descriptor = patent.assets.find((asset) => asset.assetId === input.assetId);
          if (!descriptor) throw new AutomationError("SCOPE_DENIED", "素材不属于所选专利。");
          const release = await this.options.runtime.assetStore.leaseSnapshotAssets([
            input.assetId,
          ]);
          try {
            const stored = await this.options.runtime.assetStore.readAsset(input.assetId);
            bytes = stored[input.variant];
            format = input.variant === "preview" ? "png" : descriptor.extension;
          } finally {
            release();
          }
        } else {
          if (!patent.flowchartProjects.some((project) => project.projectId === input.projectId))
            throw new AutomationError("NOT_FOUND", "流程图不属于所选专利。");
          const loaded = this.options.runtime.flowcharts.load(patentId, input.projectId);
          if (
            loaded.project.revision !==
            patent.flowchartProjects.find((project) => project.projectId === input.projectId)
              ?.revision
          )
            throw new AutomationError("REVISION_CONFLICT", "流程图版本已变化。");
          bytes = loaded.source;
          format = "drawio";
        }
        return publishAutomationBytes(bytes, input.output, format, patent.revision, {
          signal,
          grant: grant.scope,
          record,
          ledger: this.ledger,
          assertAuthorized: () => {
            this.#assertGrant(grant, patentId, true);
            this.#assertNotCancelled(signal);
          },
        });
      });
    }
    if (request.command === "asset.read") {
      const input = z
        .object({
          patentId: uuid,
          assetId: uuid,
          revision: z.number().int().nonnegative().optional(),
          variant: z.enum(["original", "preview"]).default("preview"),
        })
        .strict()
        .parse(p);
      return this.#mutateRead(async () => {
        const patent =
          input.revision === undefined
            ? await this.options.runtime.patents.captureAutomation(patentId)
            : (await this.options.runtime.snapshots.open(patentId, input.revision)).patent;
        if (!patent.assets.some((a) => a.assetId === input.assetId))
          throw new AutomationError("SCOPE_DENIED", "素材不属于所选专利版本。");
        const stored = await this.options.runtime.assetStore.readAsset(input.assetId);
        const bytes = stored[input.variant];
        if (bytes.byteLength > Math.floor(MAX_AUTOMATION_FRAME * 0.7))
          throw new AutomationError("RESULT_TOO_LARGE", "素材过大，请读取预览版本。");
        this.#assertGrant(grant, patentId);
        return {
          patentId,
          revision: patent.revision,
          descriptor: stored.descriptor,
          variant: input.variant,
          encoding: "base64",
          data: Buffer.from(bytes).toString("base64"),
        };
      });
    }
    if (
      [
        "asset.import",
        "drawing.import",
        "drawing.render",
        "flowchart.render",
        "asset.render-formula",
        "asset.render-chemistry",
      ].includes(request.command)
    )
      return this.#operate(request, grant, [patentId], async (record, signal) => {
        let imported: StoredAsset[];
        let renderedFrom: unknown;
        let drawingOutputWidthMm: number | undefined;
        let flowchart: object | undefined;
        let drawing:
          | {
              sourceKind: "image" | "dwg" | "pdf";
              warnings: string[];
              name: string;
              pageNumber: number;
            }
          | undefined;
        if (request.command === "flowchart.render") {
          const input = AutomationFlowchartRenderSchema.parse(p);
          if (!this.options.renderGraphic)
            throw new AutomationError("UNAVAILABLE", "流程图渲染服务不可用。");
          const patent = await this.#readCurrent(
            grant,
            { patentId, persisted: input.persisted },
            true,
          );
          const project = patent.flowchartProjects.find(
            (item) => item.projectId === input.projectId,
          );
          if (
            patent.revision !== input.expectedRevision ||
            !project ||
            project.revision !== input.expectedProjectRevision
          )
            throw new AutomationError("REVISION_CONFLICT", "专利或流程图版本已变化。");
          if (input.pageIndex >= project.pageCount)
            throw new AutomationError("INVALID_INPUT", "流程图页码超出范围。");
          const source = this.options.runtime.flowchartSourceStore.loadCurrent(
            patentId,
            project.projectId,
          );
          if (source.revision !== project.revision || source.sourceSha256 !== project.sourceSha256)
            throw new AutomationError("REVISION_CONFLICT", "流程图源文件版本已变化。");
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          const rendered = await this.options.renderGraphic(
            {
              kind: "flowchart",
              source: Buffer.from(source.source).toString("base64"),
              projectId: project.projectId,
              projectRevision: project.revision,
              pageIndex: input.pageIndex,
              selectedCellIds: input.selectedCellIds,
            },
            signal,
          );
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          if (rendered.mediaType !== "image/svg+xml" || !rendered.pageId)
            throw new AutomationError("RENDER_FAILED", "流程图渲染结果无效。");
          const service = new FlowchartRenderService();
          const preview = await service.render({
            patentId,
            project,
            pageId: rendered.pageId,
            exportScope: input.selectedCellIds.length ? "selection" : "page",
            selectedCellIds: input.selectedCellIds,
            borderMm: input.borderMm,
            ...(input.outputWidthMm === undefined ? {} : { outputWidthMm: input.outputWidthMm }),
            svg: Buffer.from(rendered.data, "base64").toString("utf8"),
            target: { kind: "new", insertIndex: patent.figures.length },
          });
          const claimed = service.claim(preview.previewToken, { project });
          imported = [claimed.asset];
          flowchart = {
            flowchartLink: claimed.link,
            outputWidthMm: claimed.outputWidthMm,
            warnings: preview.warnings,
          };
        } else if (request.command === "drawing.render") {
          const input = AutomationDrawingRenderSchema.parse(p);
          if (!this.options.renderGraphic)
            throw new AutomationError("UNAVAILABLE", "绘图渲染服务不可用。");
          const patent = await this.#readCurrent(
            grant,
            { patentId, persisted: input.persisted },
            true,
          );
          if (patent.revision !== input.expectedRevision)
            throw new AutomationError("REVISION_CONFLICT", "专利版本已变化。");
          const project = patent.drawingProjects.find((item) => item.projectId === input.projectId);
          if (!project || project.revision !== input.expectedProjectRevision)
            throw new AutomationError("REVISION_CONFLICT", "绘图工程版本已变化。");
          const region = project.regions.find((item) => item.id === input.regionId);
          if (!region) throw new AutomationError("NOT_FOUND", "取图区域不存在。");
          const assetId =
            project.sourceKind === "pdf" ? project.sourceAssetId : project.baseAssetId;
          if (!patent.assets.some((asset) => asset.assetId === assetId))
            throw new AutomationError("SCOPE_DENIED", "底图不属于此专利。");
          const frozenIds = [
            ...new Set(
              [
                ...(project.cad?.overlayAssetId ? [project.cad.overlayAssetId] : []),
                ...(project.detailViews ?? []).flatMap((detail) =>
                  detail.cadSource ? [detail.cadSource.baseAssetId] : [],
                ),
              ],
            ),
          ];
          if (frozenIds.some((id) => !patent.assets.some((asset) => asset.assetId === id)))
            throw new AutomationError("SCOPE_DENIED", "局部放大图不属于此专利。");
          const release = await this.options.runtime.assetStore.leaseSnapshotAssets([
            assetId,
            ...frozenIds,
          ]);
          let tileReader: Awaited<ReturnType<typeof openDrawingTileReader>> | undefined;
          try {
            const source = await this.options.runtime.assetStore.readAsset(assetId);
            const frozenCadSources: Record<string, string> = {};
            let frozenBytes = 0;
            for (const id of frozenIds) {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
              const asset = await this.options.runtime.assetStore.readAsset(id);
              frozenBytes += asset.original.byteLength;
              if (frozenBytes > 100 * 1024 * 1024)
                throw new AutomationError(
                  "INVALID_ARGUMENT",
                  "图纸辅助资源过大，请减少本次成图的放大图数量或图纸内容。",
                );
              frozenCadSources[id] = Buffer.from(asset.original).toString("base64");
            }
            this.#assertGrant(grant, patentId, true);
            this.#assertNotCancelled(signal);
            if (source.descriptor.kind === "drawing-tiles")
              tileReader = await openDrawingTileReader(source.original);
            const rendered = await this.options.renderGraphic(
              {
                kind: "drawing",
                frozenCadSources,
                source: tileReader ? "" : Buffer.from(source.original).toString("base64"),
                ...(tileReader ? { tiledIndex: tileReader.index() } : {}),
                mediaType: source.descriptor.mediaType,
                project,
                region,
                widthMm: input.widthMm,
                dpi: input.dpi,
                autoAdjustLabelSize: input.autoAdjustLabelSize,
                autoLabelScale:
                  input.autoLabelScale ??
                  (await this.options.settings?.readReadOnly())?.drawingAutoLabelScale ??
                  1,
                fitToPage: patent.books.find((book) => book.kind === "description-drawings")!
                  .document.page,
              },
              signal,
              tileReader
                ? {
                    index: tileReader.index(),
                    readTile: async (id) => {
                      this.#assertGrant(grant, patentId, true);
                      this.#assertNotCancelled(signal);
                      const data = await tileReader!.read(id);
                      this.#assertGrant(grant, patentId, true);
                      this.#assertNotCancelled(signal);
                      return data;
                    },
                  }
                : undefined,
            );
            imported = [
              await importImage({
                originalName: "drawing-region.jpg",
                bytes: Buffer.from(rendered.data, "base64"),
              }),
            ];
            drawingOutputWidthMm = rendered.outputWidthMm;
          } finally {
            tileReader?.close();
            release();
          }
          renderedFrom = {
            patentRevision: patent.revision,
            projectId: project.projectId,
            projectRevision: project.revision,
            regionId: region.id,
          };
        } else if (request.command === "asset.render-formula") {
          const input = AutomationFormulaSchema.parse(p);
          try {
            const rendered = await renderFormulaFallback(input.latex, input.outputWidthMm);
            imported = [await importImage({ originalName: "formula.png", bytes: rendered.png })];
          } catch (error) {
            if (error instanceof FormulaSyntaxError)
              throw new AutomationError("INVALID_FORMULA", error.message);
            throw error;
          }
        } else if (request.command === "asset.render-chemistry") {
          const input = AutomationChemicalSchema.parse(p);
          if (input.source) assertAutomationChemicalSource(input.source.ketSource);
          imported = [
            await rasterizeChemicalStructureAsset(input.svg, input.source, input.outputWidthMm),
          ];
        } else {
          const input =
            request.command === "drawing.import"
              ? AutomationDrawingImportSchema.parse(p)
              : AutomationAssetImportSchema.parse(p);
          const bytes = await readAllowedFile(
            input.path,
            [grant.scope.workspace.importDirectory],
            request.command === "drawing.import" ? MAX_DRAWING_INPUT_BYTES : MAX_IMAGE_BYTES,
          );
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          if (request.command === "drawing.import") {
            const drawingInput = AutomationDrawingImportSchema.parse(p);
            if (
              Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "AC10" &&
              !this.options.drawingRuntime
            )
              throw new AutomationError("UNAVAILABLE", "DWG 转换组件不可用。");
            let preview = drawingInput.previewPath
              ? await readAllowedFile(
                  drawingInput.previewPath,
                  [grant.scope.workspace.importDirectory],
                  10 * 1024 * 1024,
                )
              : undefined;
            if (!preview && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
              if (!this.options.renderGraphic)
                throw new AutomationError("UNAVAILABLE", "PDF 预览服务不可用。");
              const rendered = await this.options.renderGraphic(
                {
                  kind: "pdf-preview",
                  source: Buffer.from(bytes).toString("base64"),
                  pageNumber: drawingInput.pageNumber,
                },
                signal,
              );
              preview = Buffer.from(rendered.data, "base64");
            }
            this.#assertGrant(grant, patentId, true);
            this.#assertNotCancelled(signal);
            const result = await importDrawing(
              DrawingImportRequestSchema.parse({
                sessionId: record.operationId,
                operationId: record.operationId,
                originalName: basename(input.path),
                declaredMediaType: null,
                bytes,
                ...(preview ? { preview } : {}),
              }),
              this.options.drawingRuntime ?? "",
              signal,
            );
            imported = result.assets;
            drawing = {
              sourceKind: result.sourceKind,
              warnings: result.warnings,
              name: basename(input.path).slice(0, 200),
              pageNumber: drawingInput.pageNumber,
            };
          } else imported = [await importImage({ originalName: basename(input.path), bytes })];
        }
        this.#assertGrant(grant, patentId, true);
        this.#assertNotCancelled(signal);
        const sessionId = record.operationId;
        const stored = await this.options.runtime.assetStore.stageMany(
          sessionId,
          imported,
          record.operationId,
        );
        const stages: Stage[] = [
          ...new Map(stored.map((asset) => [asset.descriptor.assetId, asset])).values(),
        ].map((asset) => ({
          handle: randomUUID(),
          clientId: grant.clientId,
          grant,
          patentId,
          sessionId,
          descriptor: asset.descriptor,
          expiresAt: Date.now() + AUTOMATION_LEASE_MS,
          plans: new Set(),
        }));
        try {
          this.#assertGrant(grant, patentId, true);
          this.#assertNotCancelled(signal);
          for (const stage of stages) this.#stages.set(stage.handle, stage);
          const assets = stored.map((asset) => {
            const stage = stages.find(
              (item) => item.descriptor.assetId === asset.descriptor.assetId,
            )!;
            return {
              assetHandle: stage.handle,
              assetId: stage.descriptor.assetId,
              expiresAt: stage.expiresAt,
              descriptor: stage.descriptor,
            };
          });
          const source = assets[0]?.descriptor;
          const base = assets.at(-1)?.descriptor;
          if (!source || !base) throw new AutomationError("INTERNAL", "素材导入失败。");
          const result = drawing
            ? {
                assets,
                project: {
                  ...drawing,
                  sourceAssetId: source.assetId,
                  baseAssetId: base.assetId,
                  width: base.widthPx,
                  height: base.heightPx,
                  annotations: [],
                  regions: [],
                },
              }
            : {
                ...assets[0],
                ...flowchart,
                ...(renderedFrom ? { renderedFrom } : {}),
                ...(drawingOutputWidthMm === undefined
                  ? {}
                  : { outputWidthMm: drawingOutputWidthMm }),
              };
          this.ledger.update(record, "committed", result);
          this.changed();
          return result;
        } catch (error) {
          await this.options.runtime.assetStore.discardStaged(
            sessionId,
            stored.map((asset) => asset.descriptor.assetId),
            record.operationId,
          );
          for (const stage of stages) this.#stages.delete(stage.handle);
          throw error;
        }
      });
    if (request.command === "change.prepare" || request.command === "change.restore-prepare") {
      this.#assertWritable();
      const original = await this.#readCurrent(grant, { patentId });
      return this.#mutate(async () => {
        const expectedRevision = z.number().int().nonnegative().parse(p.expectedRevision);
        if (original.revision !== expectedRevision)
          throw new AutomationError("REVISION_CONFLICT", "请读取最新修订后生成方案。");
        const handles: Stage[] = [];
        let operations: z.infer<typeof AutomationOperationsSchema>;
        let prepared: Preparation;
        if (request.command === "change.restore-prepare") {
          const revision = z.number().int().nonnegative().parse(p.revision);
          const snapshot = await this.options.runtime.snapshots.open(patentId, revision);
          const candidate = preserveCurrentGraphicWorkspaces(
            structuredClone(snapshot.patent),
            original,
          );
          candidate.revision = original.revision;
          candidate.modifiedAt = original.modifiedAt;
          operations = [];
          prepared = {
            patent: candidate,
            risk: {
              requireApproval: false,
              reasons: ["恢复历史版本"],
              affectedBookKinds: candidate.books.map((b) => b.kind),
            },
            diff: {
              ...prepareAutomationChange(original, [{ type: "setMetadata" }]).diff,
              auxiliaryDocuments: {
                before: original.auxiliaryDocuments,
                after: candidate.auxiliaryDocuments,
              },
              settings: {
                before: {
                  patentType: original.patentType,
                  drawingBooksEnabled: original.drawingBooksEnabled,
                  referenceMarks: original.referenceMarks,
                  referenceMarkSettings: original.referenceMarkSettings,
                },
                after: {
                  patentType: candidate.patentType,
                  drawingBooksEnabled: candidate.drawingBooksEnabled,
                  referenceMarks: candidate.referenceMarks,
                  referenceMarkSettings: candidate.referenceMarkSettings,
                },
              },
              metadata: {
                name: { before: original.name, after: candidate.name },
                customer: { before: original.customer, after: candidate.customer },
              },
              books: candidate.books.map((b) => ({
                bookKind: b.kind,
                before: original.books.find((x) => x.kind === b.kind)!.document.content,
                after: b.document.content,
                pageBefore: original.books.find((x) => x.kind === b.kind)!.document.page,
                pageAfter: b.document.page,
              })),
              figures: {
                before: original.figures,
                after: candidate.figures,
                abstractFigureBefore: original.abstractDrawingFigureId,
                abstractFigureAfter: candidate.abstractDrawingFigureId,
              },
              restoration: { before: original, after: candidate },
            },
            touched: { bookKinds: candidate.books.map((b) => b.kind), blockIds: [] },
          };
        } else {
          operations = AutomationOperationsSchema.parse(p.operations);
          for (const op of operations)
            if (
              op.type === "attachFigure" ||
              op.type === "attachFlowchartFigure" ||
              op.type === "useAsset"
            ) {
              if (original.assets.some((asset) => asset.assetId === op.assetId)) continue;
              const stage = [...this.#stages.values()].find(
                (s) =>
                  s.grant === grant &&
                  s.patentId === patentId &&
                  s.descriptor.assetId === op.assetId &&
                  s.expiresAt > Date.now(),
              );
              if (!stage)
                throw new AutomationError(
                  "ASSET_HANDLE_EXPIRED",
                  "素材不属于当前授权或已过期，请重新导入。",
                );
              if (!original.assets.some((a) => a.assetId === stage.descriptor.assetId))
                original.assets.push(stage.descriptor);
              handles.push(stage);
            }
          prepared = prepareAutomationChange(original, operations);
          const readAsset = (id: string) => this.options.runtime.assetStore.readAsset(id);
          for (const book of prepared.patent.books)
            await validateAutomationChemicalChanges(
              original.books.find((entry) => entry.kind === book.kind)?.document.content ?? [],
              book.document.content,
              readAsset,
            );
          for (const document of prepared.patent.auxiliaryDocuments)
            await validateAutomationChemicalChanges(
              original.auxiliaryDocuments.find(
                (entry) => entry.auxiliaryDocumentId === document.auxiliaryDocumentId,
              )?.document.content ?? [],
              document.document.content,
              readAsset,
            );
        }
        this.#assertGrant(grant, patentId, true);
        if (request.command === "change.restore-prepare")
          await this.options.runtime.snapshots.readFlowchartArchive(
            patentId,
            z.number().int().nonnegative().parse(p.revision),
          );
        const change: Prepared = {
          changeId: randomUUID(),
          patentId,
          grant,
          expectedRevision,
          prepared,
          operations,
          expiresAt: Date.now() + AUTOMATION_LEASE_MS,
          restoreSnapshot: request.command === "change.restore-prepare",
          assetHandles: handles.map((s) => s.handle),
          applied: false,
        };
        this.#changes.set(change.changeId, change);
        for (const stage of handles) stage.plans.add(change.changeId);
        this.changed();
        return this.#changeReceipt(change);
      });
    }
    if (request.command === "change.apply") {
      // Receipt replay precedes expired-plan/old-approval checks, after current scope checks.
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const change = this.#requireChange(uuid.parse(p.changeId), grant);
          if (change.patentId !== patentId)
            throw new AutomationError("INVALID_INPUT", "方案目标不一致。");
          const lock = await this.barrier.acquire(patentId);
          try {
            // This gate is acquired by #operate only for the commit portion; renderer draining does not hold it.
            const committed = await this.#mutate(async () => {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
              lock.assertValid();
              const current = await this.options.runtime.patents.captureAutomation(patentId);
              if (current.revision !== change.expectedRevision)
                throw new AutomationError(
                  "REVISION_CONFLICT",
                  "GUI 保存已推进修订，请重新生成方案。",
                );
              await this.options.runtime.snapshots.create(patentId, "manual-create");
              return this.options.runtime.patents.applyAutomationChange({
                patentId,
                expectedRevision: change.expectedRevision,
                patent: change.prepared.patent,
                restoreSnapshot: change.restoreSnapshot,
                allowBookPageChanges: change.operations.some(
                  (op) =>
                    op.type === "setBookPage" ||
                    op.type === "setDrawingBooksEnabled" ||
                    op.type === "setPatentType",
                ),
                allowPatentSettingsChanges: change.operations.some((op) =>
                  PATENT_SETTINGS_OPERATIONS.has(op.type),
                ),
                allowDrawingChanges: change.operations.some((op) =>
                  DRAWING_OPERATIONS.has(op.type),
                ),
                allowAuxiliaryChanges: change.operations.some((op) =>
                  AUXILIARY_OPERATIONS.has(op.type),
                ),
                beforeCommit: () => {
                  this.#assertGrant(grant, patentId, true);
                  this.#assertNotCancelled(signal);
                  lock.assertValid();
                  if (change.expiresAt <= Date.now())
                    throw new AutomationError("CHANGE_EXPIRED", "方案已过期。");
                },
                inTransaction: (d, patent) => {
                  this.ledger.inTransaction(d, record, "committed", {
                    patentId,
                    revision: patent.revision,
                    uiSync: "pending",
                  });
                },
              });
            });
            lock.markCommitted();
            change.applied = true;
            // A resource-cleanup failure must not prevent adoption of an already committed revision.
            await this.cleanup().catch((error) => {
              this.#lastCleanupError = error;
            });
            const synced = await lock.adopt(committed);
            this.changed();
            return {
              patentId,
              revision: committed.revision,
              uiSync: synced ? "confirmed" : "failed",
            };
          } finally {
            lock.release();
          }
        },
        false,
      );
    }
    if (request.command === "history.create" || request.command === "history.delete") {
      const command = request.command;
      const input =
        command === "history.create"
          ? AutomationSnapshotCreateSchema.parse(p)
          : AutomationSnapshotDeleteSchema.parse(p);
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const lock = await this.barrier.acquire(patentId);
          try {
            return await this.#mutate(async () => {
              const beforeCommit = () => {
                this.#assertGrant(grant, patentId, true);
                this.#assertNotCancelled(signal);
                lock.assertValid();
                if (
                  this.options.runtime.patents.loadSavedPatent(patentId).revision !==
                  input.expectedRevision
                )
                  throw new AutomationError(
                    "REVISION_CONFLICT",
                    "专利已更新，请重新读取后管理历史。",
                  );
              };
              beforeCommit();
              if (command === "history.create") {
                const created = await this.options.runtime.snapshots.create(
                  patentId,
                  "manual-create",
                  {
                    beforeCommit,
                    inTransaction: (database, revision) => {
                      this.ledger.inTransaction(database, record, "running", null, {
                        kind: "snapshot-create",
                        patentId,
                        revision,
                      });
                    },
                  },
                );
                return { patentId, ...created };
              }
              const { revision } = AutomationSnapshotDeleteSchema.parse(input);
              const deleted = await this.options.runtime.snapshots.delete(patentId, revision, {
                beforeCommit,
                inTransaction: (database) =>
                  this.ledger.inTransaction(database, record, "committed", {
                    patentId,
                    revision,
                    deleted: true,
                    cleanupPending: true,
                  }),
              });
              return { patentId, revision, deleted: true, ...deleted };
            });
          } finally {
            lock.release();
          }
        },
        false,
      );
    }
    if (request.command === "history.list" || request.command === "history.preview") {
      if (request.command === "history.list")
        return {
          items: await this.#mutateRead(() => this.options.runtime.snapshots.list(patentId)),
        };
      return this.#mutateRead(() =>
        this.options.runtime.snapshots.open(
          patentId,
          z.number().int().nonnegative().parse(p.revision),
        ),
      );
    }
    if (request.command === "patent.export")
      return this.#operate(
        request,
        grant,
        [patentId],
        async (record, signal) => {
          const patent = await this.#readCurrent(
            grant,
            { patentId, ...(p.persisted === true ? { persisted: true } : {}) },
            true,
          );
          if (patent.revision !== z.number().int().nonnegative().parse(p.expectedRevision))
            throw new AutomationError("REVISION_CONFLICT", "导出版本已变化。");
          return this.options.exportPatent(patent, p, {
            signal,
            grant: grant.scope,
            record,
            ledger: this.ledger,
            assertAuthorized: () => {
              this.#assertGrant(grant, patentId, true);
              this.#assertNotCancelled(signal);
            },
          });
        },
        true,
        true,
      );
    if (request.command === "patent.read" || request.command === "patent.inspect") {
      const input =
        request.command === "patent.inspect" ? inspectionSchema.parse(p) : readSchema.parse(p);
      if (this.#scope(grant).patents[patentId] === "read") {
        if (input.sync) throw new AutomationError("SCOPE_DENIED", "只读权限不能触发保存。");
        input.persisted = true;
      }
      const patent = await this.#readCurrent(grant, input);
      if (request.command === "patent.inspect") {
        const inspection = inspectionSchema.parse(p);
        if (
          inspection.ruleIds?.some(
            (id) => !DEFAULT_PATENT_INSPECTION_RULES.some((rule) => rule.id === id),
          )
        )
          throw new AutomationError("INVALID_INPUT", "包含未知检查规则，请从 capabilities 选择。");
        const report = runPatentInspection(
          patent,
          DEFAULT_PATENT_INSPECTION_RULES.filter(
            (rule) => !inspection.ruleIds || inspection.ruleIds.includes(rule.id),
          ),
          { mode: inspection.mode },
        );
        if (
          inspection.mode === "full" &&
          (!inspection.ruleIds || inspection.ruleIds.includes(RESOURCE_HEALTH_RULE_ID))
        ) {
          try {
            const result = await inspectResourceFiles(
              patent,
              (id) => this.options.runtime.assetStore.readAsset(id),
              AbortSignal.timeout(15_000),
            );
            return mergeResourceHealth(report, patent, result);
          } catch {
            return report;
          }
        }
        return report;
      }
      const gui = await this.barrier.probe(patentId);
      if (!input.persisted && (gui.dirty || gui.unknown))
        throw new AutomationError("EDITOR_DIRTY", "读取期间界面有新的未保存编辑，请重新同步。");
      const books = patent.books
        .filter((b) => !input.bookKind || b.kind === input.bookKind)
        .map((b) => ({
          ...Object.fromEntries(Object.entries(b).filter(([key]) => key !== "editorState")),
          document: {
            ...b.document,
            content: input.blockIds
              ? b.document.content.filter((block) => input.blockIds?.includes(block.id))
              : b.document.content,
          },
        }));
      return {
        patent: {
          ...patent,
          books,
          auxiliaryDocuments:
            input.bookKind || input.blockIds
              ? []
              : patent.auxiliaryDocuments.map(({ editorState: _, ...doc }) => doc),
        },
        persisted: true,
        gui: { dirty: gui.dirty, unknown: gui.unknown },
      };
    }
    throw new AutomationError("UNSUPPORTED_COMMAND", "该命令尚未开放。");
  }
  async #readCurrent(
    grant: Grant,
    input: z.infer<typeof readSchema>,
    admitted = false,
  ): Promise<CanonicalPatent> {
    this.#assertGrant(grant, input.patentId);
    let lock: Awaited<ReturnType<AutomationBarrier["acquire"]>> | undefined;
    try {
      if (input.sync) {
        this.#assertWritable();
        this.#assertGrant(grant, input.patentId, true);
        lock = await this.barrier.acquire(input.patentId);
      } else if (!input.persisted) {
        const state = await this.barrier.probe(input.patentId);
        if (state.dirty || state.unknown)
          throw new AutomationError(
            "EDITOR_DIRTY",
            "界面有待保存内容；请同步或显式读取已保存版本。",
          );
      }
      const capture = () => this.options.runtime.patents.captureAutomation(input.patentId);
      const patent = await (admitted ? capture() : this.#mutateRead(capture));
      this.#assertGrant(grant, input.patentId);
      return patent;
    } finally {
      lock?.release();
    }
  }
  #assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AutomationError("CANCELLED", "任务已取消。");
  }
  #assertGlobal(grant: Grant, domain: AutomationGlobalDomain, write = false): void {
    this.#assertGrant(grant);
    const permission = grant.scope.global?.[domain];
    if (!permission || (write && permission !== "full"))
      throw new AutomationError("SCOPE_DENIED", "此全局管理权限需要用户单独授权。");
  }
  async #executeGlobal(
    request: AutomationRequest,
    grant: Grant,
    domain: AutomationGlobalDomain,
  ): Promise<unknown> {
    const write = !request.command.endsWith(".read");
    this.#assertGlobal(grant, domain, write);
    if (domain === "transfer") {
      const service = this.options.transfer;
      if (!service) throw new AutomationError("UNAVAILABLE", "完整数据迁移服务不可用。");
      if (request.command === "global.transfer.read") {
        AutomationTransferReadSchema.parse(request.payload);
        return this.#mutateRead(async () => {
          this.#assertGlobal(grant, domain);
          const result = await service.inspect();
          this.#assertGlobal(grant, domain);
          return result;
        });
      }
      if (request.command === "global.transfer.relocate") {
        const relocation = this.options.relocation;
        if (!relocation) throw new AutomationError("UNAVAILABLE", "文档库迁移服务不可用。");
        const input = AutomationRelocateSchema.parse(request.payload);
        const assertReady = () => {
          this.#assertGlobal(grant, "transfer", true);
          allowedPath(
            join(input.parent, `.zxw-relocation-${randomUUID()}`),
            [this.#scope(grant).workspace.exportDirectory],
            true,
          );
          relocation.assertReady();
        };
        assertReady();
        return this.#operate(
          request,
          grant,
          [],
          async (record, signal) => {
            await this.beforeExclusive();
            return this.#gate.runExclusive(
              "library-swap",
              async () => {
                assertReady();
                this.#assertNotCancelled(signal);
                this.ledger.update(record, "running", undefined, {
                  kind: "library-relocation",
                  parent: input.parent,
                });
                const target = await relocation.schedule(input.parent);
                try {
                  assertReady();
                  this.#assertNotCancelled(signal);
                } catch (error) {
                  await relocation.cancel();
                  throw error;
                }
                this.#handoffs.set(record.operationId, {
                  grant,
                  cancel: () => relocation.cancel(),
                  run: async () => {
                    try {
                      assertReady();
                      if (this.#live.size)
                        throw new AutomationError("OPERATION_IN_PROGRESS", "其他操作尚未结束。");
                      await this.beforeExclusive();
                      await this.#gate.runExclusive("library-swap", async () => {
                        assertReady();
                        relocation.restart();
                      });
                    } catch (error) {
                      await relocation.cancel();
                      throw error;
                    }
                  },
                });
                return { phase: "scheduled", target, restartPending: true };
              },
              signal,
            );
          },
          false,
        );
      }
      if (request.command.startsWith("global.transfer.import.")) {
        const imports = this.transferImports;
        if (!imports) throw new AutomationError("UNAVAILABLE", "完整包导入服务不可用。");
        // Preview handles are bound to the exact approved grant, including its expiry/revocation.
        const owner = {
          grantId: grant.grantId,
          importDirectory: this.#scope(grant).workspace.importDirectory,
          assertAuthorized: () => this.#assertGlobal(grant, "transfer", true),
        };
        owner.assertAuthorized();
        if (request.command.endsWith(".read")) {
          const input = AutomationTransferImportSchema.parse(request.payload);
          return this.#mutateRead(() => imports.read(input.importId, owner));
        }
        if (request.command.endsWith(".prepare")) {
          const input = AutomationTransferPrepareSchema.parse(request.payload);
          return this.#operate(
            request,
            grant,
            [],
            async (_record, signal) => {
              await this.beforeExclusive();
              return this.#gate.runExclusive(
                "full-data-import",
                () => imports.prepare(input.path, input.password, owner, signal),
                signal,
              );
            },
            false,
            true,
          );
        }
        if (request.command.endsWith(".discard")) {
          const input = AutomationTransferImportSchema.parse(request.payload);
          return this.#operate(request, grant, [], () => imports.discard(input.importId, owner));
        }
        const input = AutomationTransferCommitSchema.parse(request.payload);
        return this.#operate(request, grant, [], async (record) => {
          const receipt = await imports.schedule(input.importId, owner);
          this.#handoffs.set(record.operationId, {
            grant,
            cancel: () => imports.fail(input.importId),
            run: async () => {
              try {
                owner.assertAuthorized();
                // This continuation runs only after the scheduling receipt has left the socket.
                if (this.#live.size)
                  throw new AutomationError("OPERATION_IN_PROGRESS", "其他操作尚未结束。");
                await this.beforeExclusive();
                await this.#gate.runExclusive("full-data-import", async () => {
                  owner.assertAuthorized();
                  await imports.commit(input.importId, owner, async () => {
                    owner.assertAuthorized();
                    this.#databaseDetached = true;
                    this.#enabled = false;
                    clearInterval(this.#cleanupTimer);
                    await this.transport.close();
                  });
                });
              } catch (error) {
                if (!this.#databaseDetached) await imports.fail(input.importId);
                throw error;
              }
            },
          });
          return receipt;
        });
      }
      AutomationTransferExportSchema.parse(request.payload);
      return this.#operate(
        request,
        grant,
        [],
        async (record, signal) => {
          await this.beforeExclusive();
          return this.#gate.runExclusive(
            "full-data-export",
            () =>
              exportAutomationTransfer(this.options.home, service, request.payload, {
                record,
                signal,
                grant: this.#scope(grant),
                ledger: this.ledger,
                assertAuthorized: () => {
                  this.#assertGlobal(grant, domain, true);
                  this.#assertNotCancelled(signal);
                },
              }),
            signal,
          );
        },
        false,
        true,
      );
    }
    if (domain === "documents") {
      if (request.command === "global.documents.printers.read") {
        z.object({}).strict().parse(request.payload);
        const printing = this.options.printing;
        if (!printing) throw new AutomationError("UNAVAILABLE", "打印服务不可用。");
        return this.#mutateRead(async () => {
          const printers = await printing.printers();
          this.#assertGlobal(grant, domain);
          return { printers };
        });
      }
      if (request.command.startsWith("global.documents.legacy.")) {
        const service = this.options.legacyDrafts;
        if (!service) throw new AutomationError("UNAVAILABLE", "旧草稿服务不可用。");
        if (request.command.endsWith(".read")) {
          documentSchemas.AutomationLegacyReadSchema.parse(request.payload);
          return this.#mutateRead(async () => {
            const entries = [];
            for (const item of await service.list()) {
              if (
                !this.legacyDraftImported(item.draftId) &&
                !(await service.isImported(item.draftId))
              )
                entries.push(item);
            }
            this.#assertGlobal(grant, domain);
            return { entries };
          });
        }
        const input = documentSchemas.AutomationLegacyImportSchema.parse(request.payload);
        return this.#operate(
          request,
          grant,
          [],
          async (record, signal) => {
            await this.beforeExclusive();
            return this.#gate.runExclusive(
              "full-data-import",
              async () => {
                const assertAuthorized = () => {
                  this.#assertGlobal(grant, domain, true);
                  this.#assertNotCancelled(signal);
                };
                assertAuthorized();
                if (
                  this.legacyDraftImported(input.draftId) ||
                  (await service.isImported(input.draftId))
                )
                  throw new AutomationError("ALREADY_IMPORTED", "这份旧草稿已经迁入文档库。");
                const payload = await service.open(input.draftId);
                return importAutomationDocument(this.options.runtime, payload, {
                  record,
                  ledger: this.ledger,
                  assertAuthorized,
                  onImportTransaction: (database, documentId) => {
                    if (this.legacyDraftImported(input.draftId))
                      throw new AutomationError("ALREADY_IMPORTED", "这份旧草稿已经迁入文档库。");
                    this.ledger.putState(database, `automation:legacy-draft:${input.draftId}`, {
                      documentId,
                    });
                  },
                });
              },
              signal,
            );
          },
          false,
          true,
        );
      }
      if (!write)
        return this.#mutateRead(() =>
          readAutomationDocuments(this.options.runtime, request.payload, () =>
            this.#assertGlobal(grant, domain),
          ),
        );
      return this.#operate(
        request,
        grant,
        [],
        (record, signal) =>
          writeAutomationDocuments(
            this.options.runtime,
            this.options.home,
            request.command,
            request.payload,
            {
              record,
              signal,
              grant: this.#scope(grant),
              ledger: this.ledger,
              assertAuthorized: () => {
                this.#assertGlobal(grant, domain, true);
                this.#assertNotCancelled(signal);
              },
            },
            this.options.renderPdf,
            this.options.printing,
          ),
        true,
        ["global.documents.import", "global.documents.export"].includes(request.command),
      );
    }
    if (domain === "library") {
      const service = this.options.settings;
      if (!service) throw new AutomationError("UNAVAILABLE", "设置服务不可用。");
      if (request.command === "global.library.backup.restore") {
        const input = AutomationBackupDeleteSchema.parse(request.payload);
        const backup = this.options.backup;
        if (!backup) throw new AutomationError("UNAVAILABLE", "备份服务不可用。");
        return this.#operate(
          request,
          grant,
          [],
          async (record, signal) => {
            const assertAuthorized = () => {
              this.#assertGlobal(grant, domain, true);
              this.#assertNotCancelled(signal);
            };
            const capture = await backup.capture(
              input.fileName,
              (await service.readReadOnly()).backup,
            );
            assertAuthorized();
            if (capture.state !== input.expectedState)
              throw new AutomationError("REVISION_CONFLICT", "备份文件已变化，请重新检查。");
            const result = await restoreAutomationBackup(
              this.options.runtime,
              this.options.home,
              capture.bytes,
              {
                grant: this.#scope(grant),
                taskId: grant.taskId,
                record,
                ledger: this.ledger,
                assertAuthorized,
              },
            );
            this.changed();
            return result;
          },
          true,
          true,
        );
      }
      if (request.command === "global.library.backup.read") {
        const input = AutomationBackupReadSchema.parse(request.payload);
        const backup = this.options.backup;
        if (!backup) throw new AutomationError("UNAVAILABLE", "备份服务不可用。");
        return this.#mutateRead(async () => {
          const settings = (await service.readReadOnly()).backup;
          let result: unknown;
          if (input.action === "status") result = await backup.status(settings);
          else if (input.action === "inspect")
            result = await backup.describe(input.fileName, settings);
          else {
            const entries = await backup.list(settings);
            result = {
              entries: entries.slice(input.offset, input.offset + input.limit),
              total: entries.length,
            };
          }
          this.#assertGlobal(grant, domain);
          return result;
        });
      }
      if (
        request.command === "global.library.backup.run" ||
        request.command === "global.library.backup.delete"
      ) {
        const backup = this.options.backup;
        if (!backup) throw new AutomationError("UNAVAILABLE", "备份服务不可用。");
        const run = request.command === "global.library.backup.run";
        const input = (run ? AutomationBackupRunSchema : AutomationBackupDeleteSchema).parse(
          request.payload,
        );
        return this.#operate(
          request,
          grant,
          [],
          async (record, signal) => {
            const assertAuthorized = () => {
              this.#assertGlobal(grant, domain, true);
              this.#assertNotCancelled(signal);
            };
            let result: unknown;
            if (run) {
              const { expectedHash } = AutomationBackupRunSchema.parse(input);
              result = await backup.runGuarded({
                assertAuthorized,
                beforeRun: (current) => {
                  assertAuthorized();
                  if (payloadHash(librarySettings(current)) !== expectedHash)
                    throw new AutomationError(
                      "REVISION_CONFLICT",
                      "备份或快照设置已变化，请重新读取。",
                    );
                  this.ledger.update(record, "running", null, {
                    kind: "backup-run",
                    settings: current.backup,
                  });
                },
              });
            } else {
              const { fileName, expectedState } = AutomationBackupDeleteSchema.parse(input);
              await backup.delete(fileName, (state) => {
                assertAuthorized();
                if (state !== expectedState)
                  throw new AutomationError("REVISION_CONFLICT", "备份文件已变化，请重新检查。");
                this.ledger.update(record, "running", null, {
                  kind: "backup-delete",
                  fileName,
                  state,
                });
              });
              result = { deleted: true, fileName };
            }
            assertAuthorized();
            this.ledger.update(record, "committed", result);
            return result;
          },
          true,
          run,
        );
      }
      if (!write) {
        z.object({}).strict().parse(request.payload);
        return this.#mutateRead(async () => {
          const settings = librarySettings(await service.readReadOnly());
          this.#assertGlobal(grant, domain);
          return { settings, hash: payloadHash(settings) };
        });
      }
      const backup = request.command === "global.library.backup.configure";
      const input = (
        backup ? AutomationBackupConfigureSchema : AutomationSnapshotConfigureSchema
      ).parse(request.payload);
      return this.#operate(request, grant, [], async (record, signal) => {
        const assertAuthorized = () => {
          this.#assertGlobal(grant, domain, true);
          this.#assertNotCancelled(signal);
        };
        const beforeSettingsWrite = (current: AppSettings) => {
          assertAuthorized();
          if (payloadHash(librarySettings(current)) !== input.expectedHash)
            throw new AutomationError("REVISION_CONFLICT", "备份或快照设置已变化，请重新读取。");
          if (backup) {
            const settings = AutomationBackupConfigureSchema.parse(input).settings;
            if (settings.folder && settings.folder !== current.backup.folder)
              allowedPath(
                join(settings.folder, `.zxw-backup-${record.operationId}`),
                [grant.scope.workspace.exportDirectory],
                true,
              );
          }
        };
        const current = await service.readReadOnly();
        beforeSettingsWrite(current);
        this.ledger.update(record, "running", null, {
          kind: "library-configuration",
          previous: librarySettings(current),
          intended: input.settings,
        });
        let migration: unknown = null;
        if (backup) {
          if (!this.options.backup) throw new AutomationError("UNAVAILABLE", "备份服务不可用。");
          migration =
            (await this.options.backup.configure(
              AutomationBackupConfigureSchema.parse(input).settings,
              { assertAuthorized, beforeSettingsWrite },
            )) ?? null;
        } else {
          await service.update(
            { snapshot: AutomationSnapshotConfigureSchema.parse(input).settings },
            beforeSettingsWrite,
          );
          await this.options.onSnapshotChanged?.();
        }
        const settings = librarySettings(await service.readReadOnly());
        const result = { settings, hash: payloadHash(settings), migration };
        this.ledger.update(record, "committed", result);
        return result;
      });
    }
    if (
      request.command === "global.models.test-connection" ||
      request.command === "global.models.discover"
    ) {
      const input = AutomationModelProbeSchema.parse(request.payload);
      const probe = this.options.probeModel;
      if (!probe) throw new AutomationError("UNAVAILABLE", "AI 配置测试服务不可用。");
      return this.#operate(
        request,
        grant,
        [],
        async (record, signal) => {
          const assertAuthorized = () => {
            this.#assertGlobal(grant, "models", true);
            this.#assertNotCancelled(signal);
          };
          assertAuthorized();
          const result = await probe(
            request.command === "global.models.discover" ? "discover" : "test",
            input.profileId,
            signal,
            assertAuthorized,
            () => {
              assertAuthorized();
              this.ledger.update(record, "running", null, {
                kind: "model-probe",
                profileId: input.profileId,
              });
            },
          );
          assertAuthorized();
          return result;
        },
        true,
        true,
      );
    }
    if (
      request.command === "global.models.set-key" ||
      request.command === "global.models.clear-key"
    ) {
      const vault = this.options.credentials;
      const service = this.options.settings;
      if (!vault || !service)
        throw new AutomationError("UNAVAILABLE", "当前实例的密钥存储不可用。");
      const input: { profileId: string; apiKey?: string } =
        request.command === "global.models.set-key"
          ? z
              .object({ profileId: uuid, apiKey: z.string().trim().min(1).max(4000) })
              .strict()
              .parse(request.payload)
          : z.object({ profileId: uuid }).strict().parse(request.payload);
      return this.#operate(request, grant, [], async (record, signal) => {
        const settings = await service.readReadOnly();
        if (
          !settings.aiCorrection.profiles.some((profile) => profile.profileId === input.profileId)
        )
          throw new AutomationError("NOT_FOUND", "AI 模型不存在。");
        const beforeWrite = () => {
          this.#assertGlobal(grant, domain, true);
          this.#assertNotCancelled(signal);
          this.ledger.update(record, "running", null, {
            kind: "model-credential",
            profileId: input.profileId,
            present: input.apiKey !== undefined,
          });
        };
        if (input.apiKey !== undefined)
          await vault.setApiKey(input.profileId, input.apiKey, beforeWrite);
        else await vault.clearApiKey(input.profileId, beforeWrite);
        const result = { profileId: input.profileId, hasApiKey: input.apiKey !== undefined };
        this.ledger.update(record, "committed", result);
        return result;
      });
    }
    if (domain === "settings" || domain === "models") {
      const selectSettings = (settings: AppSettings) =>
        domain === "models" ? modelSettings(settings) : generalSettings(settings);
      const service = this.options.settings;
      if (!service) throw new AutomationError("UNAVAILABLE", "当前实例不支持设置管理。");
      if (!write)
        return this.#mutateRead(async () => {
          const settings = selectSettings(await service.readReadOnly());
          this.#assertGlobal(grant, domain);
          const credentialProfileIds =
            domain === "models"
              ? ((await this.options.credentials?.listProfileIds()) ?? [])
              : undefined;
          this.#assertGlobal(grant, domain);
          return {
            settings,
            hash: payloadHash(settings),
            ...(credentialProfileIds ? { credentialProfileIds } : {}),
          };
        });
      const input = z
        .object({
          expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
          patch:
            domain === "models"
              ? AutomationModelsPatchSchema
              : AutomationGeneralSettingsPatchSchema,
        })
        .strict()
        .parse(request.payload);
      return this.#operate(request, grant, [], async (record, signal) => {
        const saved = await service.update(input.patch, (current) => {
          this.#assertGlobal(grant, domain, true);
          this.#assertNotCancelled(signal);
          const previous = selectSettings(current);
          if (payloadHash(previous) !== input.expectedHash)
            throw new AutomationError("REVISION_CONFLICT", "设置已更新，请重新读取。");
          // File publication and SQLite cannot share a transaction. Persist intent first;
          // an interrupted attempt remains recovery_required and is never blindly replayed.
          this.ledger.update(record, "running", null, {
            kind: "global-settings",
            domain,
            previous,
            intended: { ...previous, ...input.patch },
          });
        });
        const result = {
          settings: selectSettings(saved),
          hash: payloadHash(selectSettings(saved)),
          effect: "设置已保存，界面在下次读取设置时生效",
        };
        this.ledger.update(record, "committed", result);
        this.options.onSettingsChanged?.(saved, input.patch);
        return result;
      });
    }
    const templates = this.options.runtime.patentTemplates;
    if (!write)
      return this.#mutateRead(() => ({
        catalog: templates.readSummary(),
        auxiliary: templates.readAuxiliary(),
      }));
    const input = PatentTemplateEditorSaveRequestSchema.omit({ sessionId: true }).parse(
      request.payload,
    );
    return this.#operate(request, grant, [], async (record) => {
      this.#assertGlobal(grant, domain, true);
      // Global template permission does not grant access to assets in private patents.
      const previewIds = (value: unknown, ids = new Set<string>()): Set<string> => {
        if (Array.isArray(value))
          value.forEach((item) => {
            previewIds(item, ids);
          });
        else if (value && typeof value === "object")
          for (const [key, child] of Object.entries(value)) {
            if (key === "previewAssetId" && typeof child === "string") ids.add(child);
            else previewIds(child, ids);
          }
        return ids;
      };
      const allowed = previewIds(templates.readSummary());
      if ([...previewIds(input)].some((id) => !allowed.has(id)))
        throw new AutomationError("SCOPE_DENIED", "模板不能引用未授权的专利资源。");
      const session = templates.openEditor({ patentType: "invention" });
      try {
        const saved = await templates.saveEditor(
          { ...input, sessionId: session.sessionId },
          (database, revision) => {
            this.#assertGlobal(grant, domain, true);
            this.ledger.inTransaction(database, record, "committed", { revision });
          },
        );
        return { revision: saved.catalog.revision };
      } finally {
        templates.closeEditor({ sessionId: session.sessionId });
      }
    });
  }
  #assertRecordScope(grant: Grant, record: OperationRecord): void {
    const domain = commandGlobalDomain(record.command);
    if (domain) this.#assertGlobal(grant, domain);
    // Receipts confirm already executed actions; they cannot restore access to a trashed patent.
    for (const id of record.target.patentIds) this.#assertGrant(grant, id, false, true);
    const result = record.result as { path?: unknown } | null;
    if (publicationCommands.has(record.command) && typeof result?.path === "string")
      assertOutputReceiptScope(result.path, [grant.scope.workspace.exportDirectory]);
  }
  #receipt(record: OperationRecord): unknown {
    return {
      operationId: record.operationId,
      requestId: record.requestId,
      command: record.command,
      status: record.status,
      result: record.result,
    };
  }
  #changeReceipt(c: Prepared): unknown {
    return {
      changeId: c.changeId,
      patentId: c.patentId,
      expectedRevision: c.expectedRevision,
      hash: payloadHash(c.prepared.patent),
      risk: c.prepared.risk,
      diff: c.prepared.diff,
      expiresAt: c.expiresAt,
    };
  }
  #requireChange(id: string, grant?: Grant): Prepared {
    const c = this.#changes.get(id);
    if (
      !c ||
      (grant && c.grant !== grant) ||
      !c.grant.active ||
      c.expiresAt <= Date.now() ||
      c.applied
    )
      throw new AutomationError("CHANGE_EXPIRED", "方案已失效，请重新生成。");
    return c;
  }
  async #operate(
    request: AutomationRequest,
    grant: Grant,
    patentIds: string[],
    execute: (record: OperationRecord, signal: AbortSignal) => Promise<unknown>,
    holdGate = true,
    background = false,
  ): Promise<unknown> {
    const hash = payloadHash({
      libraryId: this.libraryId,
      command: request.command,
      payload: request.payload,
    });
    const previous = this.ledger.read(grant.clientId, request.command, request.requestId);
    if (previous) {
      if (previous.payloadHash !== hash)
        throw new AutomationError("IDEMPOTENCY_CONFLICT", "同一请求 ID 的内容不一致。");
      this.#assertRecordScope(grant, previous);
      return this.#receipt(previous);
    }
    this.#assertWritable();
    const { record, worker } = await this.#mutate(() => {
      const record = this.ledger.reserve(
        grant.clientId,
        request.command,
        request.requestId,
        hash,
        patentIds,
      );
      if (this.#live.has(record.operationId) || record.status !== "accepted")
        return { record, worker: null };
      const controller = new AbortController();
      const worker: Live = { record, grant, controller, task: Promise.resolve() };
      this.#live.set(record.operationId, worker);
      worker.task = Promise.resolve().then(() =>
        this.#runOperation(record, grant, execute, controller, holdGate),
      );
      return { record, worker };
    });
    if (!worker || background) return this.#receipt(record);
    await worker.task;
    const result = this.ledger.byId(grant.clientId, record.operationId);
    this.#assertGrant(grant);
    if (!result) throw new AutomationError("RECOVERY_REQUIRED", "操作结果待核对。");
    this.#assertRecordScope(grant, result);
    return this.#receipt(result);
  }
  async #runOperation(
    record: OperationRecord,
    grant: Grant,
    execute: (record: OperationRecord, signal: AbortSignal) => Promise<unknown>,
    controller: AbortController,
    holdGate: boolean,
  ): Promise<void> {
    const recordFailure = (error: unknown) => {
      const stored = this.ledger.byId(grant.clientId, record.operationId);
      if (stored?.status !== "committed") {
        const status = stored?.evidence
          ? "recovery_required"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
        this.ledger.update(record, status, errorResponse(error));
      }
    };
    try {
      const task = async () => {
        try {
          this.#assertGrant(grant);
          this.#assertNotCancelled(controller.signal);
          this.ledger.update(record, "running");
          const result = await execute(record, controller.signal);
          const stored = this.ledger.byId(grant.clientId, record.operationId);
          if (stored?.status !== "committed") this.ledger.update(record, "committed", result);
        } catch (error) {
          recordFailure(error);
        }
      };
      if (holdGate) await this.#mutate(task);
      else {
        await this.#mutate(() => this.ledger.update(record, "running"));
        // GUI draining cannot retain a global mutation admission.
        const finalResult = await execute(record, controller.signal);
        // UI adoption is separate from the durable commit. Failure cannot undo it.
        await this.#mutate(() => this.ledger.update(record, "committed", finalResult));
      }
    } catch (error) {
      const stored = this.ledger.byId(grant.clientId, record.operationId);
      if (stored?.status !== "committed") {
        try {
          await this.#mutate(() => recordFailure(error));
        } catch {
          this.#lastCleanupError = new AutomationError(
            "RECOVERY_REQUIRED",
            "终态待原库恢复后核对。",
          );
        }
      }
    } finally {
      this.#live.delete(record.operationId);
      const handoff = this.#handoffs.get(record.operationId);
      if (handoff && this.ledger.byId(grant.clientId, record.operationId)?.status !== "committed") {
        // Registering a restart plan is not a durable success receipt. A failed
        // receipt must release the plan before any response can trigger it.
        this.#handoffs.delete(record.operationId);
        try {
          await handoff.cancel?.();
        } catch (error) {
          this.#lastCleanupError = error;
        }
      }
      const committed = this.ledger.byId(grant.clientId, record.operationId);
      if (committed?.status === "committed") {
        const created = ["patent.create", "patent.import", "docx.commit"].includes(record.command);
        this.options.broadcast({
          type: "libraryChanged",
          command: record.command,
          patentIds: committed.target.patentIds,
          ...(created ? { createdPatentIds: committed.target.patentIds } : {}),
        });
      }
      this.changed();
    }
  }
  #mutate<T>(task: () => T | PromiseLike<T>): Promise<T> {
    this.#assertWritable();
    return this.#gate.runMutation(IPC_CHANNELS.patentsApplyBookEdit, task);
  }
  #mutateRead<T>(task: () => T | PromiseLike<T>): Promise<T> {
    // Count reads holding the old runtime without writing a record. Safe reads remain available in recovery.
    return this.#gate.runMutation(IPC_CHANNELS.patentsFlush, task);
  }
  async cleanup(): Promise<void> {
    if (this.#disposed || this.#databaseDetached || this.options.runtime.readOnly) return;
    try {
      await this.#mutate(async () => {
        for (const [id, handoff] of this.#handoffs) {
          try {
            this.#assertGrant(handoff.grant);
          } catch {
            await handoff.cancel?.();
            this.#handoffs.delete(id);
          }
        }
        for (const [id, c] of this.#changes)
          if (c.applied || !c.grant.active || c.expiresAt <= Date.now()) {
            for (const handle of c.assetHandles) {
              const s = this.#stages.get(handle);
              if (s) {
                s.plans.delete(id);
                if (c.applied || !s.plans.size) s.expiresAt = 0;
              }
            }
            this.#changes.delete(id);
          }
        for (const [id, s] of this.#stages)
          if (!s.plans.size && (!s.grant.active || s.expiresAt <= Date.now())) {
            await this.options.runtime.assetStore.discardStaged(
              s.sessionId,
              [s.descriptor.assetId],
              s.sessionId,
            );
            this.#stages.delete(id);
          }
        this.#lastCleanupError = undefined;
        await this.docxImports.cleanup();
        await this.transferImports?.cleanup();
        await this.#recover();
      });
    } catch (error) {
      this.#lastCleanupError = error;
      if ((error as { code?: string }).code !== "OPERATION_IN_PROGRESS") throw error;
    }
  }
  legacyDraftImported(id: string): boolean {
    return this.ledger.getState(`automation:legacy-draft:${id}`) !== undefined;
  }
  async beforeExclusive(): Promise<void> {
    if (this.closer.pending)
      throw new AutomationError("OPERATION_IN_PROGRESS", "专利正在保存并关闭。");
    await this.cleanup();
    if (this.docxImports.pending)
      throw new AutomationError("OPERATION_IN_PROGRESS", "存在待处理 DOCX 导入，请先提交或放弃。");
    if (this.#stages.size)
      throw new AutomationError(
        "OPERATION_IN_PROGRESS",
        "本地 agent 存在待处理素材，请先应用或放弃方案。",
      );
  }
  async #recover(): Promise<void> {
    for (const r of this.ledger.unfinished()) {
      if (this.#live.has(r.operationId)) continue;
      if (r.evidence) {
        this.ledger.update(r, "recovery_required", {
          code: "RECOVERY_REQUIRED",
          message: publicationCommands.has(r.command)
            ? "重新授权输出目录后，按原请求查询发布结果。"
            : "上次操作中断，请核对目标状态后再决定是否重新执行。",
        });
      } else
        this.ledger.update(r, "failed", {
          code: "INTERRUPTED",
          message: "旧任务未提交，请重新生成方案。",
        });
    }
  }
  async close(): Promise<void> {
    this.#closing = true;
    await this.#enableTransition;
    for (const grant of this.#grants.values()) this.#revoke(grant);
    this.#enabled = false;
    for (const live of this.#live.values()) live.controller.abort();
    await Promise.allSettled([...this.#live.values()].map((l) => l.task));
    await this.cleanup();
    this.#disposed = true;
    clearInterval(this.#cleanupTimer);
    await this.transport.close();
  }

  /** Called under the migration exclusive gate before the old database closes. */
  async detachDatabaseForImport(): Promise<void> {
    this.#databaseDetached = true;
    clearInterval(this.#cleanupTimer);
    await this.transport.close();
  }
}

// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Document, ImageRun, Packer, Paragraph } from "docx";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCli, send } from "../../cli/client.js";
import { AGENT_CLI_POLICY_VERSION } from "../../shared/automation/policy.js";
import type { AutomationRequest } from "../../shared/automation/protocol.js";
import { createBlankDocument } from "../../shared/document/defaults.js";
import { createDetailView } from "../../shared/drawing-markup/detail-view.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import { collectPatentStructureIssues } from "../../shared/patent/document-structure-ruler.js";
import { createFactoryPatentTemplates } from "../../shared/patent/templates.js";
import { createDefaultPrintSettings } from "../../shared/printing/model.js";
import { AiCredentialVault } from "../ai-correction/ai-credential-vault.js";
import { packDrawingTiles } from "../assets/drawing-tiles.js";
import { BackupService } from "../backup/backup-service.js";
import { rasterizeChemicalStructureAsset } from "../chemistry/chemical-preview-service.js";
import { readChemicalStructureSource } from "../chemistry/structure-source.js";
import { DataTransferOperationGate } from "../data-transfer/data-transfer-operation-gate.js";
import type { PatdocPayload, PatentPatdocPayload } from "../documents/patdoc-format.js";
import { readPatdoc } from "../documents/patdoc-reader.js";
import { writePatdoc } from "../documents/patdoc-writer.js";
import { readPatentBundle } from "../documents/patent-bundle.js";
import { createLibraryRuntime, type LibraryRuntime } from "../library/library-runtime.js";
import { SettingsService } from "../settings/settings-service.js";
import { exportAutomationPatent } from "./export.js";
import { AutomationHub, type AutomationHubOptions } from "./hub.js";

let root: string, runtime: LibraryRuntime, hub: AutomationHub, gate: DataTransferOperationGate;
let token: string;
let exportOverride: AutomationHubOptions["exportPatent"] | undefined;
let aiOverride: AutomationHubOptions["runAi"];
let printingOverride: AutomationHubOptions["printing"];
let probeOverride: AutomationHubOptions["probeModel"];
let relocationOverride: AutomationHubOptions["relocation"];
let transferImportOverride: AutomationHubOptions["transferImport"];
let legacyOverride: AutomationHubOptions["legacyDrafts"];
let transferOverride: AutomationHubOptions["transfer"];
let conversationsOverride: AutomationHubOptions["conversations"];
let graphicOverride: AutomationHubOptions["renderGraphic"];
let workspaceOverride: AutomationHubOptions["chooseWorkspace"];
const testBackups: BackupService[] = [];
const proof = "a".repeat(64);
const request = (
  command: AutomationRequest["command"],
  payload: Record<string, unknown> = {},
  requestId: string = randomUUID(),
): AutomationRequest => ({
  protocolVersion: 2,
  instanceId: hub.instanceId,
  libraryId: hub.libraryId,
  accessKey: "k".repeat(64),
  command,
  payload,
  requestId,
  clientProof: proof,
  ...(token ? { token } : {}),
});
const call = async (
  command: AutomationRequest["command"],
  payload: Record<string, unknown> = {},
  id?: string,
): Promise<any> => hub.execute(request(command, payload, id));
async function authorize(
  full = true,
  patentIds: string[] = [],
  allowCreate = true,
  exportDirectories?: string[],
) {
  for (const grant of hub.state().grants)
    await hub.control({ action: "revoke", grantId: grant.grantId }, 1);
  const pair = await call("pair.begin", { label: "Test agent" });
  await hub.control(
    {
      action: "approvePair",
      pairId: pair.pairId,
      scope: {
        patents: Object.fromEntries(patentIds.map((id) => [id, full ? "full" : "read"])),
        createLimit: allowCreate ? 1 : 0,
        workspace: {
          importDirectory: root,
          ...(exportDirectories?.length === 0
            ? {}
            : { exportDirectory: exportDirectories?.[0] ?? root }),
        },
      },
    },
    1,
  );
  token = (await call("pair.poll")).token;
}
async function create(id = "create-test") {
  return (await call("patent.create", { patentType: "invention", name: "节能装置" }, id)).result;
}
async function prepare(patentId: string, expectedRevision: number) {
  return call("change.prepare", {
    patentId,
    expectedRevision,
    operations: [
      { type: "insertParagraph", bookKind: "abstract", afterBlockId: null, text: "新增摘要段落" },
      { type: "insertParagraph", bookKind: "claims", afterBlockId: null, text: "新增权利要求" },
    ],
  });
}
async function openHub() {
  const settings = new SettingsService(join(root, "app-settings.json"));
  const backup = new BackupService({
    settings,
    delegate: {
      listModified: async () => [],
      backupOne: async () => {},
      inspect: async () => {
        throw new Error("fixture has no backup files");
      },
      restoreOne: async () => {
        throw new Error("fixture has no backup files");
      },
    },
  });
  testBackups.push(backup);
  hub = new AutomationHub({
    runtime,
    home: join(root, "home"),
    version: "test",
    label: "isolated",
    participants: () => [],
    broadcast: () => {},
    accessInstructions: async (instanceId) => `manual --json; connect --instance ${instanceId}`,
    gate,
    manual: async () => "manual",
    chooseWorkspace: (...args) =>
      workspaceOverride ? workspaceOverride(...args) : Promise.resolve(null),
    runAi: (...args) =>
      aiOverride ? aiOverride(...args) : Promise.reject(new Error("Test AI unavailable")),
    printing: {
      printers: async () => printingOverride?.printers() ?? [],
      submit: async (...args) => {
        if (!printingOverride) throw new Error("Test printing unavailable");
        return printingOverride.submit(...args);
      },
    },
    probeModel: (...args) => probeOverride!(...args),
    relocation: {
      schedule: (parent) => relocationOverride!.schedule(parent),
      cancel: async () => {
        await relocationOverride?.cancel();
      },
      assertReady: () => relocationOverride!.assertReady(),
      restart: () => relocationOverride!.restart(),
    },
    transferImport: {
      prepare: (...args) => transferImportOverride!.prepare(...args),
      discard: (id) => transferImportOverride!.discard(id),
      schedule: (id) => transferImportOverride!.schedule(id),
      commit: (...args) => transferImportOverride!.commit(...args),
      fail: (id) => transferImportOverride!.fail(id),
    },
    legacyDrafts: {
      list: () => legacyOverride!.list(),
      open: (id) => legacyOverride!.open(id),
      isImported: (id) => legacyOverride!.isImported(id),
    },
    transfer: {
      inspect: async () => {
        if (!transferOverride) throw new Error("Test transfer unavailable");
        return transferOverride.inspect();
      },
      exportPackage: async (request) => {
        if (!transferOverride) throw new Error("Test transfer unavailable");
        return transferOverride.exportPackage(request);
      },
    },
    conversations: {
      read: (input) => {
        if (!conversationsOverride) throw new Error("Test conversations unavailable");
        return conversationsOverride.read(input);
      },
      run: (...args) => {
        if (!conversationsOverride) throw new Error("Test conversations unavailable");
        return conversationsOverride.run(...args);
      },
    },
    settings,
    backup,
    renderGraphic: async (...args) => {
      if (!graphicOverride) throw new Error("Test graphic renderer unavailable");
      return graphicOverride(...args);
    },
    credentials: new AiCredentialVault(root, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`test-sealed:${value}`),
      decryptString: (value) => value.toString().replace(/^test-sealed:/u, ""),
    }),
    exportPatent: (patent, payload, context) =>
      exportOverride
        ? exportOverride(patent, payload, context)
        : exportAutomationPatent(runtime, async () => new Uint8Array(), patent, payload, context),
  });
  await hub.initialize();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zxw-"));
  token = "";
  exportOverride = undefined;
  aiOverride = undefined;
  printingOverride = undefined;
  graphicOverride = undefined;
  workspaceOverride = undefined;
  conversationsOverride = undefined;
  transferOverride = undefined;
  legacyOverride = undefined;
  probeOverride = undefined;
  transferImportOverride = undefined;
  relocationOverride = undefined;
  runtime = await createLibraryRuntime({
    libraryRoot: join(root, "library"),
    readOnly: false,
    runRecovery: false,
    startBackgroundSchedulers: false,
  });
  runtime.patentTemplates.initializeFromLegacySettings(null);
  gate = new DataTransferOperationGate();
  await openHub();
  await hub.control(
    { action: "setEnabled", enabled: true, policyAcceptedVersion: AGENT_CLI_POLICY_VERSION },
    1,
  );
  await authorize();
});
test("onboarding instructions use this instance without creating requests or expanding grants", async () => {
  const before = hub.state();
  const instructions = await hub.control({ action: "accessInstructions" }, 1);
  expect(instructions).toContain(`connect --instance ${hub.instanceId}`);
  expect(hub.state().pendingPairs).toEqual(before.pendingPairs);
  expect(hub.state().grants).toEqual(before.grants);
  await hub.control({ action: "setEnabled", enabled: false }, 1);
  await expect(hub.control({ action: "accessInstructions" }, 1)).rejects.toMatchObject({
    code: "AUTOMATION_DISABLED",
  });
});
test("migration detaches automation before database closure so shutdown does not access a closed database", async () => {
  await hub.detachDatabaseForImport();
  await runtime.close();
  await expect(hub.close()).resolves.toBeUndefined();
});
test("enabling Agent CLI requires explicit agreement to the current policy", async () => {
  await hub.control({ action: "setEnabled", enabled: false }, 1);
  await expect(hub.control({ action: "setEnabled", enabled: true }, 1)).rejects.toMatchObject({
    code: "POLICY_CONSENT_REQUIRED",
  });
  expect(hub.state().enabled).toBe(false);
  expect(hub.state().instance).toBeNull();
});
test("legacy enabled preferences without consent do not start the local service", async () => {
  await hub.close();
  await writeFile(join(root, "home", "preferences.json"), JSON.stringify({ enabled: true }));
  await openHub();
  expect(hub.state().enabled).toBe(false);
  expect(hub.state().instance).toBeNull();
});
test.each(["2026-01-01", ""])(
  "outdated policy %s cannot enable the local service",
  async (version) => {
    await hub.control({ action: "setEnabled", enabled: false }, 1);
    await expect(
      hub.control({ action: "setEnabled", enabled: true, policyAcceptedVersion: version }, 1),
    ).rejects.toMatchObject({ code: "POLICY_CONSENT_REQUIRED" });
    expect(hub.state().instance).toBeNull();
    await hub.close();
    await writeFile(
      join(root, "home", "preferences.json"),
      JSON.stringify({
        enabled: true,
        policyAcceptedVersion: version,
        policyAcceptedAt: new Date().toISOString(),
      }),
    );
    await openHub();
    expect(hub.state().enabled).toBe(false);
    expect(hub.state().instance).toBeNull();
  },
);
test("failed consent persistence closes the new transport and preserves disabled preferences", async () => {
  await hub.control({ action: "setEnabled", enabled: false }, 1);
  const path = join(root, "home", "preferences.json");
  const before = await readFile(path, "utf8");
  vi.spyOn(gate, "runMutation").mockRejectedValueOnce(new Error("Test persistence failure"));
  await expect(
    hub.control(
      { action: "setEnabled", enabled: true, policyAcceptedVersion: AGENT_CLI_POLICY_VERSION },
      1,
    ),
  ).rejects.toThrow("Test persistence failure");
  expect(hub.state().enabled).toBe(false);
  expect(hub.state().instance).toBeNull();
  expect(await readFile(path, "utf8")).toBe(before);
});
test("failed transport startup does not persist enabled consent", async () => {
  await hub.control({ action: "setEnabled", enabled: false }, 1);
  const path = join(root, "home", "preferences.json");
  const before = await readFile(path, "utf8");
  vi.spyOn(hub.transport, "start").mockRejectedValueOnce(new Error("Test startup failure"));
  await expect(
    hub.control(
      { action: "setEnabled", enabled: true, policyAcceptedVersion: AGENT_CLI_POLICY_VERSION },
      1,
    ),
  ).rejects.toThrow("Test startup failure");
  expect(hub.state().enabled).toBe(false);
  expect(await readFile(path, "utf8")).toBe(before);
});
test.each([undefined, "invalid timestamp"])(
  "incomplete consent timestamp %s fails closed",
  async (time) => {
    await hub.close();
    await writeFile(
      join(root, "home", "preferences.json"),
      JSON.stringify({
        enabled: true,
        policyAcceptedVersion: AGENT_CLI_POLICY_VERSION,
        policyAcceptedAt: time,
      }),
    );
    await openHub();
    expect(hub.state().enabled).toBe(false);
    expect(hub.state().instance).toBeNull();
  },
);
afterEach(async () => {
  for (const backup of testBackups.splice(0)) await backup.shutdown();
  await hub.close();
  await runtime.close();
  await rm(root, { recursive: true, force: true });
});

test("drawing rendering checks project revisions, scopes and revocation before staging output", async () => {
  const created = await create();
  const path = join(root, "render-source.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), path);
  const imported = (await call("drawing.import", { patentId: created.patentId, path })).result;
  imported.project.regions = [
    {
      id: "all",
      name: "全图",
      kind: "rectangle",
      points: [
        { x: 0, y: 0 },
        { x: imported.project.width, y: 0 },
        { x: imported.project.width, y: imported.project.height },
        { x: 0, y: imported.project.height },
      ],
    },
  ];
  const frozen = createDetailView(
    imported.project,
    { x: 20, y: 20 },
    10,
    { x: 50, y: 50 },
    "A",
    2,
    12,
    1,
    "frozen-detail",
  );
  frozen.cadSource = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
    assetId: imported.project.sourceAssetId,
    baseAssetId: imported.project.baseAssetId,
    mapping: { originX: 0, originY: 100, scale: 1 },
    width: imported.project.width,
    height: imported.project.height,
  };
  imported.project.detailViews = [frozen];
  expect(imported.project.sourceAssetId).not.toBe(imported.project.baseAssetId);
  imported.project.cad = {
    version: 1,
    engine: "cadcraft",
    engineVersion: "00c7613f1af3c73f7157fa91d9fe2635c6f23c06",
    assetId: imported.project.sourceAssetId,
    overlayAssetId: imported.project.sourceAssetId,
    mapping: { originX: 0, originY: 100, scale: 1 },
    unified: 1,
  };
  const prepared = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: 0,
    operations: [
      ...imported.assets.map((asset: { assetId: string }) => ({
        type: "useAsset",
        assetId: asset.assetId,
      })),
      { type: "createDrawingProject", project: imported.project },
    ],
  });
  await call("change.apply", { patentId: created.patentId, changeId: prepared.changeId });
  const patent = await runtime.patents.captureAutomation(created.patentId);
  const project = patent.drawingProjects[0]!;
  const input = {
    patentId: patent.patentId,
    expectedRevision: patent.revision,
    projectId: project.projectId,
    expectedProjectRevision: 0,
    regionId: "all",
  };
  const render = vi.fn<NonNullable<AutomationHubOptions["renderGraphic"]>>(async () => ({
    data: (await readFile(path)).toString("base64"),
    width: project.width,
    height: project.height,
    mediaType: "image/png" as const,
    outputWidthMm: 110,
  }));
  graphicOverride = render;
  expect(
    (await call("drawing.render", { ...input, expectedProjectRevision: 1 })).result.error.code,
  ).toBe("REVISION_CONFLICT");
  expect(render).not.toHaveBeenCalled();
  const settings = new SettingsService(join(root, "app-settings.json"));
  await settings.update({ drawingAutoLabelScale: 1.5 });
  const rendered = await call("drawing.render", input);
  expect(rendered.status).toBe("committed");
  expect(rendered.result.renderedFrom.projectId).toBe(project.projectId);
  expect(rendered.result.outputWidthMm).toBe(110);
  expect(render.mock.calls[0]?.[0]).toMatchObject({ autoLabelScale: 1.5 });
  const frozenAsset = await runtime.assetStore.readAsset(project.baseAssetId);
  const overlayAsset = await runtime.assetStore.readAsset(project.sourceAssetId);
  expect(render.mock.calls[0]?.[0]).toMatchObject({
    frozenCadSources: {
      [project.baseAssetId]: Buffer.from(frozenAsset.original).toString("base64"),
      [project.sourceAssetId]: Buffer.from(overlayAsset.original).toString("base64"),
    },
  });
  expect((await call("drawing.render", { ...input, autoLabelScale: 0.75 })).status).toBe(
    "committed",
  );
  expect(render.mock.lastCall?.[0]).toMatchObject({ autoLabelScale: 0.75 });
  expect((await call("asset.preview", { assetHandle: rendered.result.assetHandle })).data).toEqual(
    expect.any(String),
  );
  await updateScope({ [patent.patentId]: "read" });
  await expect(call("drawing.render", input)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await updateScope({ [patent.patentId]: "full" });
  let entered = false;
  graphicOverride = async (graphicRequest, signal) => {
    entered = true;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return render(graphicRequest, signal);
  };
  const request = call("drawing.render", input).catch(() => undefined);
  await vi.waitFor(() => expect(entered).toBe(true));
  await updateScope({ [patent.patentId]: "read" });
  await request;
  expect(hub.state().stagedAssetCount).toBe(0);
});

test("tiled drawing rendering uses a bounded lease and rechecks authority for each tile", async () => {
  const created = await create();
  const opened = await runtime.patents.open(created.patentId);
  const directory = join(root, "synthetic-tiles");
  await mkdir(directory);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000000 800000"><path d="M0 0L1000000 800000" stroke="black"/></svg>',
  );
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").toUpperCase();
  const rect = { x: 0, y: 0, width: 1000, height: 800 };
  await writeFile(join(directory, "tile-0.svg"), svg);
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({
      version: 1,
      width: 1000,
      height: 800,
      tier: "large",
      primitives: 1,
      tiles: [
        { id: "tile-0", core: rect, render: rect, byteLength: svg.length, sha256: hash(svg) },
      ],
    }),
  );
  const packed = await packDrawingTiles(directory);
  const common = {
    widthPx: 1000,
    heightPx: 800,
    previewByteLength: packed.preview.length,
    previewSha256: hash(packed.preview),
  };
  const owner = { kind: "patent" as const, patentId: created.patentId };
  const raw = Buffer.from("AC1032 synthetic");
  const source = await runtime.assetStore.install(owner, {
    original: raw,
    preview: packed.preview,
    descriptor: {
      ...common,
      assetId: randomUUID(),
      kind: "drawing-source",
      originalName: "synthetic.dwg",
      extension: "dwg",
      mediaType: "image/vnd.dwg",
      byteLength: raw.length,
      sha256: hash(raw),
    },
  });
  const base = await runtime.assetStore.install(owner, {
    original: packed.container,
    preview: packed.preview,
    descriptor: {
      ...common,
      assetId: randomUUID(),
      kind: "drawing-tiles",
      originalName: "synthetic.cadtiles",
      extension: "cadtiles",
      mediaType: "application/vnd.zxw.cad-tiles+zip",
      byteLength: packed.container.length,
      sha256: hash(packed.container),
    },
  });
  const project = {
    ...drawingProjectFixture(source.descriptor.assetId),
    baseAssetId: base.descriptor.assetId,
    sourceKind: "dwg" as const,
  };
  await runtime.patents.applyFigureEdit({
    patentId: created.patentId,
    sessionId: opened.sessionId,
    expectedRevision: opened.revision,
    figures: [],
    assets: [source.descriptor, base.descriptor],
    abstractDrawingFigureId: null,
    drawingProjects: [project],
  });
  await runtime.patents.release(opened.sessionId);
  const patent = await runtime.patents.captureAutomation(created.patentId);
  const input = {
    patentId: patent.patentId,
    expectedRevision: patent.revision,
    projectId: project.projectId,
    expectedProjectRevision: 0,
    regionId: project.regions[0]!.id,
  };
  graphicOverride = async (request, _signal, lease) => {
    expect(request.kind).toBe("drawing");
    expect(request.source).toBe("");
    expect(lease?.index.tiles).toHaveLength(1);
    expect(await lease!.readTile("tile-0")).toEqual(svg);
    return {
      data: (await readFile(resolve("tests/fixtures/images/sample.png"))).toString("base64"),
      width: 100,
      height: 100,
      mediaType: "image/png",
    };
  };
  expect((await call("drawing.render", input, "tile-render")).status).toBe("committed");
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continuation = new Promise<void>((resolve) => {
    resume = resolve;
  });
  graphicOverride = async (_request, _signal, lease) => {
    entered();
    await continuation;
    await expect(lease!.readTile("tile-0")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    throw new Error("revoked");
  };
  const pending = call("drawing.render", input, "tile-revoked").catch(() => undefined);
  await started;
  await updateScope({ [patent.patentId]: "read" });
  resume();
  await pending;
  expect(hub.state().stagedAssetCount).toBe(0);
});

test("read-only document authority cannot repair an uncertain publication receipt", async () => {
  await globalGrant({ documents: "full" });
  const created = await call("global.documents.create", { title: "导出恢复" });
  const update = hub.ledger.update.bind(hub.ledger);
  const spy = vi.spyOn(hub.ledger, "update").mockImplementation((...args) => {
    if (args[0].command === "global.documents.export" && args[1] === "committed")
      throw new Error("receipt failure");
    return update(...args);
  });
  const exported = await call("global.documents.export", {
    documentId: created.result.documentId,
    expectedRevision: 0,
    format: "patdoc",
    output: join(root, "uncertain-document.patdoc"),
  });
  await vi.waitFor(() =>
    expect(hub.ledger.byId(hub.state().grants[0]!.clientId, exported.operationId)?.status).toBe(
      "recovery_required",
    ),
  );
  spy.mockRestore();
  await globalGrant({ documents: "read" });
  expect((await call("operation.status", { id: exported.operationId })).status).toBe(
    "recovery_required",
  );
  await globalGrant({ documents: "full" });
  expect((await call("operation.status", { id: exported.operationId })).status).toBe("committed");
});

test("independent document PATDOC import and export preserve archived editor state", async () => {
  await globalGrant({ documents: "full" });
  const document = createBlankDocument("导入编辑状态");
  const paragraph = document.content[0];
  if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
  paragraph.content = [{ type: "text", text: "保存正文", marks: [] }];
  const editorState = { selection: { from: 2, to: 2 }, scrollTop: 123 };
  const source = join(root, "state-source.patdoc");
  const output = join(root, "state-export.patdoc");
  await writePatdoc(source, { document, assets: [], settings: {}, editorState });
  const imported = await call("global.documents.import", { path: source });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: imported.operationId })).status).toBe("committed"),
  );
  const receipt = await call("operation.status", { id: imported.operationId });
  const opened = await runtime.library.open(receipt.result.documentId);
  expect(opened.editorState).toEqual(editorState);
  await runtime.library.release(opened.sessionId);
  const exported = await call("global.documents.export", {
    documentId: receipt.result.documentId,
    expectedRevision: 0,
    format: "patdoc",
    output,
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: exported.operationId })).status).toBe("committed"),
  );
  expect((await readPatdoc<PatdocPayload>(output)).editorState).toEqual(editorState);
});

test("independent chemical document updates reject invalid source without changing saved content", async () => {
  await globalGrant({ documents: "full" });
  const ketSource =
    '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"C"}],"bonds":[]}}';
  const asset = await rasterizeChemicalStructureAsset(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M0 0L50 50"/></svg>',
    { ketSource },
  );
  const document = createBlankDocument("结构测试");
  document.assets = [asset.descriptor];
  document.content = [
    {
      id: randomUUID(),
      type: "chemical-structure",
      ketSource,
      previewAssetId: asset.descriptor.assetId,
      widthMm: 80,
      alignment: "center",
    },
  ];
  const path = join(root, "chemical-document.patdoc");
  await writePatdoc(path, { document, assets: [asset], settings: {}, editorState: {} });
  const imported = await call("global.documents.import", { path });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: imported.operationId })).status).toBe("committed"),
  );
  const receipt = await call("operation.status", { id: imported.operationId });
  const documentId = receipt.result.documentId;
  const current = await call("global.documents.read", { action: "get", documentId });
  const invalid = structuredClone(current.document);
  invalid.content[0].ketSource = "not JSON";
  const failed = await call("global.documents.update", {
    documentId,
    expectedRevision: 0,
    document: invalid,
  });
  expect(failed.status).toBe("failed");
  expect(failed.result.error.code).toBe("INVALID_CHEMICAL_SOURCE");
  expect((await call("global.documents.read", { action: "get", documentId })).document).toEqual(
    current.document,
  );
  current.document.content[0].widthMm = 90;
  expect(
    (
      await call("global.documents.update", {
        documentId,
        expectedRevision: 0,
        document: current.document,
      })
    ).status,
  ).toBe("committed");
});

test("independent document assets and file round trips preserve ownership and content", async () => {
  await globalGrant({ documents: "full" });
  const created = await call("global.documents.create", { title: "素材文档" });
  const documentId = created.result.documentId;
  const image = join(root, "document.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), image);
  const imported = await call("global.documents.asset-import", {
    documentId,
    expectedRevision: 0,
    path: image,
  });
  expect(imported.status).toBe("committed");
  const descriptor = imported.result.descriptor;
  const current = await call("global.documents.read", { action: "get", documentId });
  current.document.assets = [descriptor];
  current.document.content.push({
    id: randomUUID(),
    type: "figure",
    assetId: descriptor.assetId,
    widthMm: 50,
    alignment: "center",
  });
  const saved = await call("global.documents.update", {
    documentId,
    expectedRevision: 0,
    document: current.document,
  });
  expect(saved.status).toBe("committed");
  expect(
    (
      await call("global.documents.read", {
        action: "asset",
        documentId,
        assetId: descriptor.assetId,
      })
    ).descriptor,
  ).toEqual(descriptor);
  const other = await call("global.documents.create", { title: "其他文档" });
  await expect(
    call("global.documents.read", {
      action: "asset",
      documentId: other.result.documentId,
      assetId: descriptor.assetId,
    }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  const otherDocument = await call("global.documents.read", {
    action: "get",
    documentId: other.result.documentId,
  });
  otherDocument.document.assets = [descriptor];
  expect(
    (
      await call("global.documents.update", {
        documentId: other.result.documentId,
        expectedRevision: 0,
        document: otherDocument.document,
      })
    ).result.error.code,
  ).toBe("SCOPE_DENIED");
  for (const format of ["patdoc", "docx"] as const) {
    const output = join(root, `independent.${format}`);
    const exported = await call("global.documents.export", {
      documentId,
      expectedRevision: 1,
      format,
      output,
    });
    await vi.waitFor(async () =>
      expect((await call("operation.status", { id: exported.operationId })).status).toBe(
        "committed",
      ),
    );
    expect((await readFile(output)).subarray(0, 2).toString()).toBe("PK");
  }
  const reimport = await call(
    "global.documents.import",
    { path: join(root, "independent.patdoc") },
    "document-reimport",
  );
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: reimport.operationId })).status).toBe("committed"),
  );
  const receipt = await call("operation.status", { id: reimport.operationId });
  const restored = await call("global.documents.read", {
    action: "get",
    documentId: receipt.result.documentId,
  });
  const restoredAsset = restored.document.assets[0];
  expect(restoredAsset.assetId).not.toBe(descriptor.assetId);
  expect(restored.document.content).toEqual(
    current.document.content.map((block: { type: string }) =>
      block.type === "figure" ? { ...block, assetId: restoredAsset.assetId } : block,
    ),
  );
  expect(restored.document.documentId).not.toBe(current.document.documentId);
  await call("global.documents.trash", {
    documentId,
    expectedRevision: 1,
    expectedDeletedAt: null,
  });
  const deleted = await call("global.documents.read", { action: "get", documentId });
  expect(
    (
      await call("global.documents.delete", {
        documentId,
        expectedRevision: 1,
        expectedDeletedAt: deleted.deletedAt,
      })
    ).status,
  ).toBe("committed");
  expect(
    (
      await call("global.documents.read", {
        action: "asset",
        documentId: receipt.result.documentId,
        assetId: restored.document.assets[0].assetId,
      })
    ).descriptor.assetId,
  ).toBe(restored.document.assets[0].assetId);
});

test("independent documents require separate grants and provide atomic edits, conflict protection and lifecycle", async () => {
  await expect(call("global.documents.read", { action: "list" })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await globalGrant({ library: "full" });
  await expect(call("global.documents.create", { title: "独立文档" })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await globalGrant({ documents: "full" });
  const created = await call(
    "global.documents.create",
    { title: "独立文档" },
    "create-independent",
  );
  expect(created.status).toBe("committed");
  expect(
    await call("global.documents.create", { title: "独立文档" }, "create-independent"),
  ).toEqual(created);
  const documentId = created.result.documentId;
  expect((await call("global.documents.read", { action: "list" })).total).toBe(1);
  const initial = await call("global.documents.read", { action: "get", documentId });
  const edited = structuredClone(initial.document);
  edited.title = "已编辑";
  edited.content[0].content = [{ type: "text", text: "正文", marks: [] }];
  const input = { documentId, expectedRevision: 0, document: edited };
  const lease = await runtime.library.open(documentId);
  expect((await call("global.documents.update", input)).status).toBe("failed");
  await expect(call("global.documents.read", { action: "get", documentId })).rejects.toBeDefined();
  expect(
    (await call("global.documents.read", { action: "get", documentId, persisted: true })).revision,
  ).toBe(0);
  await runtime.library.release(lease.sessionId, { preserveBlank: true });
  const inTransaction = hub.ledger.inTransaction.bind(hub.ledger);
  vi.spyOn(hub.ledger, "inTransaction").mockImplementation((...args) => {
    if (args[1].requestId === "document-rollback" && args[2] === "committed")
      throw new Error("receipt failure");
    return inTransaction(...args);
  });
  expect((await call("global.documents.update", input, "document-rollback")).status).toBe("failed");
  expect((await call("global.documents.read", { action: "get", documentId })).revision).toBe(0);
  const saved = await call("global.documents.update", input, "document-edit");
  expect(saved.status).toBe("committed");
  expect(saved.result.revision).toBe(1);
  expect((await call("global.documents.update", input)).status).toBe("failed");
  await globalGrant({ documents: "read" });
  expect((await call("global.documents.read", { action: "get", documentId })).document.title).toBe(
    "已编辑",
  );
  await expect(
    call("global.documents.trash", { documentId, expectedRevision: 1, expectedDeletedAt: null }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ documents: "full" });
  expect(
    (
      await call("global.documents.trash", {
        documentId,
        expectedRevision: 1,
        expectedDeletedAt: null,
      })
    ).status,
  ).toBe("committed");
  const trashed = await call("global.documents.read", { action: "get", documentId });
  expect(trashed.deletedAt).toEqual(expect.any(String));
  expect(
    (
      await call("global.documents.restore", {
        documentId,
        expectedRevision: 1,
        expectedDeletedAt: trashed.deletedAt,
      })
    ).status,
  ).toBe("committed");
  expect(
    (
      await call("global.documents.delete", {
        documentId,
        expectedRevision: 1,
        expectedDeletedAt: trashed.deletedAt,
      })
    ).status,
  ).toBe("failed");
  await call("global.documents.trash", {
    documentId,
    expectedRevision: 1,
    expectedDeletedAt: null,
  });
  const again = await call("global.documents.read", { action: "get", documentId });
  expect(
    (
      await call("global.documents.delete", {
        documentId,
        expectedRevision: 1,
        expectedDeletedAt: again.deletedAt,
      })
    ).status,
  ).toBe("committed");
  expect((await call("global.documents.read", { action: "list", scope: "trash" })).total).toBe(0);
});

test("backup restore creates task-owned copies without spending patent quota and commits receipts atomically", async () => {
  const original = await create();
  const output = join(root, "patent-backup.patdoc");
  const exported = await call("patent.export", {
    patentId: original.patentId,
    expectedRevision: 0,
    format: "patdoc",
    output,
    persisted: true,
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: exported.operationId })).status).toBe("committed"),
  );
  await globalGrant({ library: "full" });
  const config = await call("global.library.read");
  await call("global.library.backup.configure", {
    expectedHash: config.hash,
    settings: { enabled: false, folder: root, intervalMinutes: 5 },
  });
  const state = await call("global.library.backup.read", {
    action: "inspect",
    fileName: "patent-backup.patdoc",
  });
  const input = { fileName: state.fileName, expectedState: state.state };
  const restore = await call("global.library.backup.restore", input, "restore-patent");
  let patentId = "";
  await vi.waitFor(async () => {
    const receipt = await call("operation.status", { id: restore.operationId });
    expect(receipt.status).toBe("committed");
    patentId = receipt.result.patents[0].patentId;
  });
  expect(patentId).not.toBe(original.patentId);
  expect((await call("patent.read", { patentId, persisted: true })).patent.name).toContain("恢复");
  expect((await call("global.library.backup.restore", input, "restore-patent")).status).toBe(
    "committed",
  );
  expect(await runtime.patents.list("active")).toHaveLength(2);
  expect(hub.state().grants[0]?.createdCount).toBe(1);
  const independent = createBlankDocument("独立文档备份");
  await writePatdoc(join(root, "document.patdoc"), {
    document: independent,
    settings: {},
    editorState: {},
    assets: [],
  });
  const docState = await call("global.library.backup.read", {
    action: "inspect",
    fileName: "document.patdoc",
  });
  const inTransaction = hub.ledger.inTransaction.bind(hub.ledger);
  vi.spyOn(hub.ledger, "inTransaction").mockImplementation((...args) => {
    if (args[1].requestId === "restore-failed" && args[2] === "committed")
      throw new Error("receipt unavailable");
    return inTransaction(...args);
  });
  const failed = await call(
    "global.library.backup.restore",
    { fileName: docState.fileName, expectedState: docState.state },
    "restore-failed",
  );
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: failed.operationId })).status).toBe("failed"),
  );
  expect(
    runtime.database.read((database) =>
      database.prepare("SELECT count(*) AS n FROM documents").get(),
    ),
  ).toEqual({ n: 0 });
  const document = await call("global.library.backup.restore", {
    fileName: docState.fileName,
    expectedState: docState.state,
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: document.operationId })).status).toBe("committed"),
  );
  const restoredDocument = await call("operation.status", { id: document.operationId });
  const openedDocument = await runtime.library.open(restoredDocument.result.documentId);
  expect(openedDocument.document.title).toBe("独立文档备份");
  await runtime.library.release(openedDocument.sessionId, { preserveBlank: true });
  expect(
    runtime.database.read((database) =>
      database.prepare("SELECT count(*) AS n FROM documents").get(),
    ),
  ).toEqual({ n: 1 });
  const grant = hub.state().grants[0]!;
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: {
        ...grant.scope,
        patents: { [original.patentId]: "full" },
        global: { library: "read" },
      },
    },
    1,
  );
  await expect(call("patent.read", { patentId })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(call("global.library.backup.restore", input)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});

test("backup management separates reads from writes, checks file state, and replays deletion", async () => {
  await globalGrant({ library: "full" });
  const config = await call("global.library.read");
  const saved = await call("global.library.backup.configure", {
    expectedHash: config.hash,
    settings: { enabled: false, folder: root, intervalMinutes: 5 },
  });
  const fileName =
    "PWB-AUTO-PAT-00000000-0000-4000-8000-000000000001-r1-10000000-0000-4000-8000-000000000003.patdoc";
  await writeFile(join(root, fileName), "fixture");
  await globalGrant({ library: "read" });
  expect((await call("global.library.backup.read", { action: "list" })).entries).toHaveLength(1);
  expect((await call("global.library.backup.read", { action: "status" })).folder).toBe(root);
  const described = await call("global.library.backup.read", { action: "inspect", fileName });
  await expect(
    call("global.library.backup.delete", { fileName, expectedState: described.state }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(
    call("global.library.backup.run", { expectedHash: saved.result.hash }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ library: "full" });
  await writeFile(join(root, fileName), "changed fixture");
  expect(
    (await call("global.library.backup.delete", { fileName, expectedState: described.state }))
      .result.error.code,
  ).toBe("REVISION_CONFLICT");
  const current = await call("global.library.backup.read", { action: "inspect", fileName });
  const input = { fileName, expectedState: current.state };
  const deleted = await call("global.library.backup.delete", input, "delete-backup");
  expect(deleted.status).toBe("committed");
  expect(await call("global.library.backup.delete", input, "delete-backup")).toEqual(deleted);
  await expect(stat(join(root, fileName))).rejects.toMatchObject({ code: "ENOENT" });
  const run = await call("global.library.backup.run", { expectedHash: saved.result.hash });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: run.operationId })).status).toBe("committed"),
  );
  const stale = await call("global.library.backup.run", { expectedHash: "0".repeat(64) });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: stale.operationId })).result.error.code).toBe(
      "REVISION_CONFLICT",
    ),
  );
});

test("library configuration is independently authorized, revision checked and restricted to approved output directories", async () => {
  await create();
  await expect(call("global.library.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ settings: "full" });
  await expect(call("global.library.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ library: "read" });
  const current = await call("global.library.read");
  const input = { expectedHash: current.hash, settings: { enabled: false, intervalMinutes: 15 } };
  await expect(call("global.library.snapshot.configure", input)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await globalGrant({ library: "full" });
  const saved = await call("global.library.snapshot.configure", input, "snapshot-config");
  expect(saved.status).toBe("committed");
  expect(saved.result.settings.snapshot).toEqual(input.settings);
  expect(await call("global.library.snapshot.configure", input, "snapshot-config")).toEqual(saved);
  expect((await call("global.library.snapshot.configure", input)).result.error.code).toBe(
    "REVISION_CONFLICT",
  );
  const backup = {
    expectedHash: saved.result.hash,
    settings: { enabled: false, folder: root, intervalMinutes: 10 },
  };
  expect(
    (
      await call("global.library.backup.configure", {
        ...backup,
        settings: { ...backup.settings, folder: resolve(root, "..") },
      })
    ).result.error.code,
  ).toBe("SCOPE_DENIED");
  const configured = await call("global.library.backup.configure", backup);
  expect(configured.status).toBe("committed");
  expect((await call("global.library.read")).settings.backup).toEqual(backup.settings);
  await expect(call("global.models.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("printing requires full scope and a selected printer, records submission once and preserves uncertain outcomes", async () => {
  const created = await create();
  const patent = await runtime.patents.captureAutomation(created.patentId);
  const defaults = createDefaultPrintSettings();
  const submit = vi.fn(
    async (...args: Parameters<NonNullable<AutomationHubOptions["printing"]>["submit"]>) => {
      args[5]();
    },
  );
  printingOverride = {
    printers: async () => [
      {
        deviceName: "fixture",
        displayName: "Fixture",
        description: null,
        duplex: "unknown",
        color: "unknown",
        paperSize: "unknown",
      },
    ],
    submit,
  };
  expect((await call("patent.printers", { patentId: patent.patentId })).printers).toHaveLength(1);
  const payload = {
    patentId: patent.patentId,
    expectedRevision: patent.revision,
    layout: defaults.layout,
    output: { ...defaults.output, printerDeviceName: "fixture" },
    acceptWarnings: collectPatentStructureIssues(patent).map((issue) => issue.kind),
  };
  const pending = await call("patent.print", payload, "print-once");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: pending.operationId })).status).toBe("committed"),
  );
  expect((await call("patent.print", payload, "print-once")).result.submitted).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  submit.mockImplementationOnce(async (...args) => {
    args[5]();
    throw new Error("driver disconnected");
  });
  const uncertain = await call("patent.print", payload, "uncertain-print");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: uncertain.operationId })).status).toBe(
      "recovery_required",
    ),
  );
  await call("patent.print", payload, "uncertain-print");
  expect(submit).toHaveBeenCalledTimes(2);
  const absent = await call("patent.print", {
    ...payload,
    output: { ...payload.output, printerDeviceName: "missing" },
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: absent.operationId })).status).toBe("failed"),
  );
  expect(submit).toHaveBeenCalledTimes(2);
  await authorize(false, [patent.patentId], false);
  await expect(call("patent.print", payload)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("bundle export preflights every patent grant, preserves native restore data and never overwrites", async () => {
  const first = await create();
  const other = await runtime.patents.create({
    patentType: "invention",
    name: "ungranted",
    templates: createFactoryPatentTemplates(randomUUID),
  });
  await runtime.patents.release(other.sessionId);
  const output = join(root, "patents.zip");
  const payload = {
    patents: [
      { patentId: first.patentId, expectedRevision: first.revision },
      { patentId: other.patentId, expectedRevision: other.patent.revision },
    ],
    format: "patdoc",
    output,
  };
  await expect(call("patent.export-bundle", payload)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  await authorize(true, [first.patentId, other.patentId], false);
  const accepted = await call("patent.export-bundle", payload, "bundle");
  let receipt: any;
  await vi.waitFor(async () => {
    receipt = await call("operation.status", { id: accepted.operationId });
    expect(receipt.status).toBe("committed");
  });
  expect((await readPatentBundle(output)).items).toHaveLength(2);
  expect(await call("patent.export-bundle", payload, "bundle")).toEqual(receipt);
  const original = await readFile(output);
  const again = await call("patent.export-bundle", payload);
  await vi.waitFor(async () => {
    expect((await call("operation.status", { id: again.operationId })).status).toBe("failed");
  });
  expect(await readFile(output)).toEqual(original);
  await authorize(false, [first.patentId, other.patentId], false);
  await expect(call("patent.export-bundle", payload)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});

test("DOCX preview and commit create one owned patent atomically and reject expired owner access", async () => {
  const path = join(root, "claims.docx");
  await writeFile(
    path,
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("权利要求书"),
              new Paragraph("1. 一种隔离导入装置，包括控制器。"),
            ],
          },
        ],
      }),
    ),
  );
  const preview = await call("docx.prepare", { paths: [path] });
  expect(preview.units[0].target).toEqual({ kind: "official-book", bookKind: "claims" });
  expect(await call("docx.preview", { sessionId: preview.sessionId })).toEqual(preview);
  const payload = {
    sessionId: preview.sessionId,
    patentType: "invention",
    name: "DOCX 导入",
    customer: null,
    assignments: preview.units.map((unit: any) => ({
      unitId: unit.unitId,
      title: unit.title,
      target: unit.target,
    })),
    acknowledgedWarningIds: preview.warnings.map((warning: any) => warning.warningId),
  };
  const transaction = vi.spyOn(hub.ledger, "inTransaction").mockImplementationOnce(() => {
    throw new Error("receipt failure");
  });
  const failed = await call("docx.commit", payload, "docx-failed");
  expect(failed.status).toBe("failed");
  expect(await runtime.patents.list("active")).toHaveLength(0);
  transaction.mockRestore();
  const committed = await call("docx.commit", payload, "docx-success");
  expect(committed.status).toBe("committed");
  const patent = await call("patent.read", { patentId: committed.result.patentId });
  expect(JSON.stringify(patent.patent.books)).toContain("隔离导入装置");
  expect(await call("docx.commit", payload, "docx-success")).toEqual(committed);
  expect(await runtime.patents.list("active")).toHaveLength(1);
  for (let i = 0; i < 4; i++) await create(`docx-initial-quota-${i}`);
  await expect(call("docx.prepare", { paths: [path] })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await authorize(true, [], true);
  const abandoned = await call("docx.prepare", { paths: [path] });
  await authorize(true, [], true);
  await expect(call("docx.preview", { sessionId: abandoned.sessionId })).rejects.toMatchObject({
    code: "IMPORT_EXPIRED",
  });
});

test("DOCX images stay staged until commit, quota is rechecked, and discard removes access", async () => {
  const sharp = (await import("sharp")).default;
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const path = join(root, "description-drawings.docx");
  await writeFile(
    path,
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("说明书附图"),
              new Paragraph({
                children: [
                  new ImageRun({
                    type: "png",
                    data: image,
                    transformation: { width: 10, height: 10 },
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    ),
  );
  await expect(call("docx.prepare", { paths: [path, path] })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    call("docx.prepare", { paths: [join(root, "..", "outside.docx")] }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  const first = await call("docx.prepare", { paths: [path] });
  let second = await call("docx.prepare", { paths: [path] });
  const assetId = first.units[0].document.content.find(
    (node: any) => node.type === "figure",
  ).assetId;
  const preview = await call("docx.preview-asset", { sessionId: first.sessionId, assetId });
  expect(Buffer.from(preview.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  await expect(
    call("docx.preview-asset", { sessionId: first.sessionId, assetId: randomUUID() }),
  ).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
  const payload = (value: any) => ({
    sessionId: value.sessionId,
    patentType: "invention",
    name: "图片导入",
    customer: null,
    assignments: value.units.map((unit: any) => ({
      unitId: unit.unitId,
      title: unit.title,
      target: unit.target,
    })),
    acknowledgedWarningIds: value.warnings.map((warning: any) => warning.warningId),
  });
  const discardOriginal = runtime.assetStore.discardStaged.bind(runtime.assetStore);
  let finishDiscard!: () => void;
  const disposing = vi
    .spyOn(runtime.assetStore, "discardStaged")
    .mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finishDiscard = resolve;
      });
      await discardOriginal(...args);
    });
  const discard = call("docx.discard", { sessionId: second.sessionId });
  try {
    await vi.waitFor(() => expect(finishDiscard).toBeDefined());
    const duringDiscard = await call("docx.commit", payload(second));
    expect(duringDiscard.status).toBe("failed");
    expect(duringDiscard.result.error.code).toBe("OPERATION_IN_PROGRESS");
  } finally {
    finishDiscard();
    await discard;
    disposing.mockRestore();
  }
  second = await call("docx.prepare", { paths: [path] });
  for (let i = 0; i < 4; i++) await create(`docx-quota-${i}`);
  const saved = await call("docx.commit", payload(first));
  expect(saved.status).toBe("committed");
  const rejected = await call("docx.commit", payload(second));
  expect(rejected.status).toBe("failed");
  expect(rejected.result.error.code).toBe("SCOPE_DENIED");
  expect(await runtime.patents.list("active")).toHaveLength(5);
  expect((await call("docx.discard", { sessionId: second.sessionId })).discarded).toBe(true);
  expect((await runtime.assetStore.readAsset(assetId)).original.length).toBeGreaterThan(0);
  await expect(call("docx.preview", { sessionId: second.sessionId })).rejects.toMatchObject({
    code: "IMPORT_EXPIRED",
  });
});

test("create red template title once; atomic multi-book apply receipt survives plan disposal and reauthorization", async () => {
  const created = await create();
  const replay = await create();
  expect(replay).toEqual(created);
  const current = await runtime.patents.captureAutomation(created.patentId);
  expect(JSON.stringify(current.books)).toContain("#FF0000");
  const change = await prepare(created.patentId, created.revision);
  const applied = await call(
    "change.apply",
    { patentId: created.patentId, changeId: change.changeId },
    "apply-one",
  );
  expect(applied.status).toBe("committed");
  expect(applied.result.uiSync).toBe("confirmed");
  expect(applied.result.revision).toBe(created.revision + 1);
  await expect(call("change.inspect", { changeId: change.changeId })).rejects.toMatchObject({
    code: "CHANGE_EXPIRED",
  });
  await authorize(true, [created.patentId]);
  expect(
    await call(
      "change.apply",
      { patentId: created.patentId, changeId: change.changeId },
      "apply-one",
    ),
  ).toEqual(applied);
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(
    applied.result.revision,
  );
  await expect(
    call("patent.create", { patentType: "invention", name: "不同输入" }, "create-test"),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("read-only scope denies all mutations, sync, show and export without creating an operation", async () => {
  const created = await create();
  await authorize(false, [created.patentId], false);
  const capture = await call("patent.read", { patentId: created.patentId });
  expect(capture.persisted).toBe(true);
  await expect(create("denied")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  for (const command of [
    "ai.correct",
    "ai.polish",
    "ai.conversation.run",
    "patent.export",
    "patent.sync",
    "patent.show",
    "patent.close",
    "change.prepare",
    "change.restore-prepare",
    "change.apply",
    "asset.import",
    "drawing.import",
  ] as const)
    await expect(call(command, { patentId: created.patentId })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  await expect(
    call("patent.read", { patentId: created.patentId, sync: true }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(call("patent.read", { patentId: randomUUID() })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(
    created.revision,
  );
});

test("concurrent retries start one create executor", async () => {
  const createSpy = vi.spyOn(runtime.patents, "create");
  const responses = await Promise.all([create("duplicate"), create("duplicate")]);
  expect(createSpy).toHaveBeenCalledTimes(1);
  expect(await runtime.patents.list("active")).toHaveLength(1);
  expect(responses.some(Boolean)).toBe(true);
});

test("cancel reaches a long export while full-library exclusive reservation waits", async () => {
  const created = await create();
  let started!: () => void;
  const entering = new Promise<void>((r) => {
    started = r;
  });
  exportOverride = async (_patent, _payload, context) => {
    started();
    await new Promise<void>((r) =>
      context.signal.addEventListener("abort", () => r(), { once: true }),
    );
    context.assertAuthorized();
    return {};
  };
  const received = await call(
    "patent.export",
    {
      patentId: created.patentId,
      expectedRevision: created.revision,
      format: "pdf",
      output: join(root, "a.pdf"),
    },
    "cancel-me",
  );
  await entering;
  let exclusiveRan = false;
  const exclusive = gate.runExclusive("full-data-export", () => {
    exclusiveRan = true;
  });
  expect(exclusiveRan).toBe(false);
  expect((await call("operation.cancel", { id: received.operationId })).status).toBe(
    "cancelRequested",
  );
  await exclusive;
  expect(exclusiveRan).toBe(true);
  expect(
    (await call("operation.status", { requestId: "cancel-me", command: "patent.export" })).status,
  ).toBe("cancelled");
});

test("staged images block exclusivity only until all referring plans are discarded", async () => {
  const created = await create();
  const image = join(root, "中文 附图.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), image);
  const imported = (
    await call("asset.import", { patentId: created.patentId, path: image }, "image")
  ).result;
  const change = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: created.revision,
    operations: [{ type: "attachFigure", assetId: imported.assetId }],
  });
  await expect(hub.beforeExclusive()).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  await expect(call("asset.discard", { assetHandle: imported.assetHandle })).rejects.toMatchObject({
    code: "ASSET_IN_USE",
  });
  await call("change.discard", { changeId: change.changeId });
  await hub.beforeExclusive();
  expect(hub.state().stagedAssetCount).toBe(0);
  expect(
    (await call("operation.status", { command: "asset.import", requestId: "image" })).status,
  ).toBe("committed");
});

test("document snapshot restore preserves current flowcharts and their latest editable sources", async () => {
  const created = await create();
  const project = await runtime.flowcharts.create({
    patentId: created.patentId,
    expectedPatentRevision: created.revision,
    name: "历史流程图",
    source: Buffer.from('<mxfile><diagram id="a">old</diagram></mxfile>'),
    pageCount: 1,
    lastPageId: "a",
  });
  const historical = await runtime.patents.captureAutomation(created.patentId);
  await runtime.snapshots.create(created.patentId, "manual-create");
  const changed = await runtime.flowcharts.save({
    patentId: created.patentId,
    projectId: project.project.projectId,
    expectedPatentRevision: historical.revision,
    expectedProjectRevision: 0,
    source: Buffer.from('<mxfile><diagram id="a">updated</diagram></mxfile>'),
    pageCount: 1,
    lastPageId: "a",
  });
  const settings = await runtime.patents.updateSettings({
    patentId: created.patentId,
    expectedRevision: changed.patentRevision,
    patentType: "utility-model",
  });
  await runtime.flowcharts.create({
    patentId: created.patentId,
    expectedPatentRevision: settings.revision,
    name: "新增流程图",
    source: Buffer.from('<mxfile><diagram id="b">new</diagram></mxfile>'),
    pageCount: 1,
    lastPageId: "b",
  });
  const latest = await runtime.patents.captureAutomation(created.patentId);
  const change = await call("change.restore-prepare", {
    patentId: created.patentId,
    expectedRevision: latest.revision,
    revision: 0,
  });
  const result = await call(
    "change.apply",
    { patentId: created.patentId, changeId: change.changeId },
    "restore",
  );
  expect(result.status).toBe("committed");
  const restored = await runtime.patents.captureAutomation(created.patentId);
  expect(restored.revision).toBe(latest.revision + 1);
  expect(restored.flowchartProjects).toEqual(latest.flowchartProjects);
  expect(restored.patentType).toBe("invention");
  expect(
    runtime.flowchartSourceStore.loadCurrent(created.patentId, project.project.projectId).source,
  ).toEqual(Uint8Array.from(Buffer.from('<mxfile><diagram id="a">updated</diagram></mxfile>')));
  const continued = await runtime.flowcharts.save({
    patentId: created.patentId,
    projectId: project.project.projectId,
    expectedPatentRevision: restored.revision,
    expectedProjectRevision: changed.project.revision,
    source: Buffer.from('<mxfile><diagram id="a">continued</diagram></mxfile>'),
    pageCount: 1,
    lastPageId: "a",
  });
  expect(continued.project.revision).toBe(2);
  expect(continued.source).toEqual(
    Uint8Array.from(Buffer.from('<mxfile><diagram id="a">continued</diagram></mxfile>')),
  );
});

test("real socket client pairing keeps credentials private and creates through CLI", async () => {
  const run = async (...args: string[]) => {
    const output: string[] = [],
      diagnostics: string[] = [];
    const code = await runCli([...args, "--home", join(root, "home"), "--json"], {
      stdout: (s) => output.push(s),
      stderr: (s) => diagnostics.push(s),
    });
    return { code, data: JSON.parse(output.join("")), output: output.join(""), diagnostics };
  };
  const listed = await run("instance", "list");
  expect(listed.output).not.toContain("accessKey");
  const requestFile = join(root, "cli-authorization-request.json");
  await writeFile(
    requestFile,
    JSON.stringify({ requested: { task: "CLI 流程测试", createLimit: 1 } }),
  );
  const first = await run("connect", "--instance", hub.instanceId, "--input", requestFile);
  expect(first.code).toBe(4);
  expect(
    hub.state().pendingPairs.find((p) => p.pairId === first.data.value.pairId)?.requested,
  ).toEqual({ task: "CLI 流程测试", createLimit: 1 });
  await hub.control(
    {
      action: "approvePair",
      pairId: first.data.value.pairId,
      scope: {
        patents: {},
        createLimit: 1,
        workspace: {},
      },
    },
    1,
  );
  const connected = await run("connect", "--instance", hub.instanceId);
  expect(connected.code).toBe(0);
  expect(connected.output).not.toContain("token");
  const locationFile = join(root, "cli-location.json");
  await writeFile(locationFile, JSON.stringify({ kind: "export", directory: "/unconfirmed" }));
  const cancelled = await run("workspace", "select", "--input", locationFile);
  expect(cancelled.code).toBe(1);
  expect(cancelled.data.value).toEqual({ status: "cancelled", kind: "export" });
  expect(cancelled.diagnostics.join(" ")).not.toContain("command=workspace.select");
  workspaceOverride = async () => root;
  const selected = await run("workspace", "select", "--input", locationFile);
  expect(selected.code).toBe(0);
  expect(selected.data.value).toMatchObject({ status: "selected", directory: root });
  expect(selected.output).not.toContain("token");
  const created = await run(
    "patent",
    "create",
    "--patent-type",
    "utility-model",
    "--name",
    "中文 CLI 专利",
    "--request-id",
    "cli-create",
  );
  expect(created.code).toBe(0);
  expect(created.data.value.status).toBe("committed");
  const checked = await run(
    "operation",
    "status",
    "--request-id",
    "cli-create",
    "--command",
    "patent.create",
  );
  expect(checked.data.value.result).toEqual(created.data.value.result);
  const descriptor = hub.transport.descriptor!;
  expect(
    (
      await send(
        { ...descriptor, accessKey: "x".repeat(64) },
        "patent.list",
        {},
        { clientProof: proof, token },
        "bad",
        1000,
      )
    ).ok,
  ).toBe(false);
  if (process.platform !== "win32")
    expect((await stat(join(root, "home", "profiles", "default.json"))).mode & 0o777).toBe(0o600);
});

test("patdoc export is readable, refuses overwrite and directory links without touching original", async () => {
  const created = await create();
  const patent = await runtime.patents.captureAutomation(created.patentId);
  const output = join(root, "中文 输出.patdoc");
  const input = {
    patentId: created.patentId,
    expectedRevision: created.revision,
    format: "patdoc",
    output,
    acceptWarnings: collectPatentStructureIssues(patent).map((issue) => issue.kind),
  };
  const received = await call("patent.export", input, "export");
  let status: any;
  await vi.waitFor(async () => {
    status = await call("operation.status", { id: received.operationId });
    expect(status.status).toBe("committed");
  });
  const exported = await readPatdoc<PatentPatdocPayload>(output);
  expect(exported.patent.books).toEqual(patent.books);
  await authorize(true, [created.patentId], false, []);
  await expect(call("operation.status", { id: received.operationId })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await authorize(true, [created.patentId]);
  const before = await readFile(output);
  const duplicate = await call("patent.export", input, "second-export");
  await vi.waitFor(async () => {
    expect((await call("operation.status", { id: duplicate.operationId })).status).toBe("failed");
  });
  expect(await readFile(output)).toEqual(before);
  const outside = await mkdtemp(join(tmpdir(), "zxw-outside-"));
  try {
    await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const linked = await call(
      "patent.export",
      { ...input, output: join(root, "link", "no.patdoc") },
      "linked-export",
    );
    await vi.waitFor(async () => {
      expect((await call("operation.status", { id: linked.operationId })).status).toBe("failed");
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("sync and template reads cannot bypass a full-library reservation", async () => {
  const created = await create();
  let release!: () => void;
  const exclusive = gate.runExclusive(
    "full-data-export",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
    await expect(call("patent.sync", { patentId: created.patentId })).rejects.toMatchObject({
      code: "OPERATION_IN_PROGRESS",
    });
    await expect(call("template.list")).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  } finally {
    release();
    await exclusive;
  }
});
test("approval waiting on scope validation cannot survive disabling and reopening the entry", async () => {
  const ids = await runtime.patents.list("active");
  let resolveList!: (value: typeof ids) => void;
  const pendingList = new Promise<typeof ids>((resolve) => {
    resolveList = resolve;
  });
  vi.spyOn(runtime.patents, "list").mockImplementationOnce(() => pendingList);
  const pair: any = await hub.execute({
    ...request("pair.begin", { label: "Late approval" }),
    clientProof: "b".repeat(64),
  });
  const approving = hub.control(
    {
      action: "approvePair",
      pairId: pair.pairId,
      scope: {
        patents: {},
        createLimit: 1,
        workspace: {},
      },
    },
    1,
  );
  const outcome = approving.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await hub.control({ action: "setEnabled", enabled: false }, 1);
  await hub.control(
    { action: "setEnabled", enabled: true, policyAcceptedVersion: AGENT_CLI_POLICY_VERSION },
    1,
  );
  resolveList(ids);
  expect(await outcome).toMatchObject({ error: { code: "PAIR_EXPIRED" } });
  expect(hub.state().grants).toHaveLength(0);
});
test("cleanup never mistakes a newly reserved executor for an orphan", async () => {
  const updates = vi.spyOn(hub.ledger, "update");
  const reserve = hub.ledger.reserve.bind(hub.ledger);
  vi.spyOn(hub.ledger, "reserve").mockImplementationOnce((...args) => {
    const record = reserve(...args);
    queueMicrotask(() => {
      void hub.cleanup();
    });
    return record;
  });
  const result = await call(
    "patent.create",
    { patentType: "invention", name: "并发登记" },
    "cleanup-race",
  );
  expect(result.status).toBe("committed");
  expect(updates.mock.calls.some(([, status]) => status === "failed")).toBe(false);
  expect(await runtime.patents.list("active")).toHaveLength(1);
});
test("block-scoped read does not return the full book through editorState", async () => {
  const created = await create();
  const plan = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: created.revision,
    operations: [
      { type: "insertParagraph", bookKind: "abstract", afterBlockId: null, text: "只读取这一段" },
      {
        type: "insertParagraph",
        bookKind: "abstract",
        afterBlockId: null,
        text: "此次不请求的另一段",
      },
    ],
  });
  await call(
    "change.apply",
    { patentId: created.patentId, changeId: plan.changeId },
    "scoped-read-apply",
  );
  const patent = await runtime.patents.captureAutomation(created.patentId);
  const block = patent.books
    .find((book) => book.kind === "abstract")!
    .document.content.find((block) => JSON.stringify(block).includes("只读取这一段"))!;
  const result = await call("patent.read", {
    patentId: created.patentId,
    bookKind: "abstract",
    blockIds: [block.id],
  });
  expect(result.patent.books[0].document.content).toEqual([block]);
  expect(result.patent.books[0].editorState).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("此次不请求的另一段");
});
test("missing publication target returns an uncertain receipt rather than hiding status", async () => {
  const created = await create();
  const record = hub.ledger.reserve(
    hub.state().grants[0]!.clientId,
    "patent.export",
    "missing-output",
    "a".repeat(64),
    [created.patentId],
  );
  hub.ledger.update(record, "recovery_required", null, {
    phase: "publishing",
    target: join(root, "missing.docx"),
    temp: join(root, "temp"),
    hash: "0".repeat(64),
    size: 1,
    device: 1,
    inode: 1,
    revision: 0,
    format: "docx",
    warnings: [],
  });
  expect((await call("operation.status", { id: record.operationId })).status).toBe(
    "recovery_required",
  );
});
test("template APIs expose metadata and fields without leaking captured template text", async () => {
  await authorize(false, [], false);
  const source = structuredClone(runtime.patentTemplates.resolveCreationSource("invention"));
  const paragraph = source.templates.abstract.content.find((block) => block.type === "paragraph")!;
  paragraph.content = [{ type: "text", text: "未授权模板正文秘密 {{patentName}}", marks: [] }];
  vi.spyOn(runtime.patentTemplates, "resolveCreationSource").mockReturnValue(source);
  const catalog = runtime.patentTemplates.readSummary();
  catalog.invention.slots[0]!.abstract = source.templates.abstract;
  vi.spyOn(runtime.patentTemplates, "readSummary").mockReturnValue(catalog);
  const described = await call("template.describe", { patentType: "invention" });
  expect(JSON.stringify(described)).not.toContain("未授权模板正文秘密");
  expect(
    described.slots.find((slot: { slot: string }) => slot.slot === "abstract").fields,
  ).toContain("patentName");
  expect(JSON.stringify(await call("template.list"))).not.toContain("未授权模板正文秘密");
});

test("full patent permission applies destructive edits and history restoration without another approval", async () => {
  const created = await create();
  const first = await prepare(created.patentId, 0);
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: first.changeId })).status,
  ).toBe("committed");
  const current = await runtime.patents.captureAutomation(created.patentId);
  const block = current.books.find((b) => b.kind === "abstract")!.document.content[0]!;
  const removal = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: 1,
    operations: [{ type: "deleteBlock", bookKind: "abstract", blockId: block.id }],
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: removal.changeId })).status,
  ).toBe("committed");
  const restored = await call("change.restore-prepare", {
    patentId: created.patentId,
    expectedRevision: 2,
    revision: 1,
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: restored.changeId }))
      .status,
  ).toBe("committed");
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(3);
});

test("an authorized client reconnects after the pairing request lease without asking again", async () => {
  const existing = hub.state().grants[0]!;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
  try {
    const connected = await call("pair.begin");
    expect(connected.status).toBe("authorized");
    expect(connected.grantId).toBe(existing.grantId);
    expect(hub.state().pendingPairs).toHaveLength(0);
  } finally {
    clock.mockRestore();
  }
});

async function updateScope(
  patents: Record<string, "read" | "full">,
  createLimit = 0,
  automaticWorkspace = false,
) {
  const grant = hub.state().grants[0]!;
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { patents, createLimit, workspace: automaticWorkspace ? {} : grant.scope.workspace },
    },
    1,
  );
  return hub.state().grants[0]!;
}

test("A full, B read and C hidden remain isolated across list, history, editing and assets", async () => {
  const a = await create();
  const b = await runtime.patents.create({
    templates: createFactoryPatentTemplates(randomUUID),
    patentType: "invention",
    name: "只读参考",
  });
  const c = await runtime.patents.create({
    templates: createFactoryPatentTemplates(randomUUID),
    patentType: "invention",
    name: "不应泄露的题目",
  });
  await runtime.patents.release(b.sessionId);
  await runtime.patents.release(c.sessionId);
  await updateScope({ [a.patentId]: "full", [b.patentId]: "read" });
  expect((await call("patent.list")).total).toBe(2);
  expect(JSON.stringify(await call("patent.list"))).not.toContain(c.patentId);
  expect((await call("patent.read", { patentId: b.patentId })).patent.name).toBe("只读参考");
  const plan = await prepare(a.patentId, 0);
  expect(
    (await call("change.apply", { patentId: a.patentId, changeId: plan.changeId })).status,
  ).toBe("committed");
  for (const command of [
    "patent.read",
    "patent.inspect",
    "history.list",
    "history.preview",
    "asset.read",
    "change.prepare",
  ] as const)
    await expect(call(command, { patentId: c.patentId })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  await expect(prepare(b.patentId, 0)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect((await runtime.patents.captureAutomation(b.patentId)).revision).toBe(0);
  expect((await runtime.patents.captureAutomation(c.patentId)).revision).toBe(0);
});

test("a read-only reference with unsaved GUI content reads persisted data and never drains or writes", async () => {
  const a = await create();
  await updateScope({ [a.patentId]: "read" });
  vi.spyOn(hub.barrier, "probe").mockResolvedValue({ dirty: true, unknown: false });
  const drain = vi.spyOn(hub.barrier, "acquire");
  const before = runtime.database.read((db) => db.prepare("SELECT total_changes() AS count").get());
  expect((await call("patent.read", { patentId: a.patentId })).gui.dirty).toBe(true);
  await call("patent.inspect", { patentId: a.patentId });
  await call("history.list", { patentId: a.patentId });
  const after = runtime.database.read((db) => db.prepare("SELECT total_changes() AS count").get());
  expect(after).toEqual(before);
  expect(drain).not.toHaveBeenCalled();
});

test("creation count and ownership commit atomically and never include GUI or other clients", async () => {
  const a = await create();
  expect(await create()).toEqual(a);
  const owned = [a.patentId];
  for (let i = 0; i < 4; i++) owned.push((await create(`ownership-quota-${i}`)).patentId);
  expect(
    (await call("patent.create", { patentType: "invention", name: "超出名额" }, "excess")).status,
  ).toBe("failed");
  const grant = hub.state().grants[0]!;
  expect(grant.createdCount).toBe(5);
  expect(grant.scope.patents[a.patentId]).toBe("full");
  const other = await runtime.patents.create({
    templates: createFactoryPatentTemplates(randomUUID),
    patentType: "invention",
    name: "GUI created",
  });
  await runtime.patents.release(other.sessionId);
  expect(
    (await call("patent.list")).items.map((item: { patentId: string }) => item.patentId).sort(),
  ).toEqual(owned.sort());
  const pair: any = await hub.execute({
    ...request("pair.begin"),
    clientProof: "z".repeat(64),
    token: undefined,
  });
  await hub.control(
    {
      action: "approvePair",
      pairId: pair.pairId,
      scope: { patents: {}, createLimit: 1, workspace: {} },
    },
    1,
  );
  const connected: any = await hub.execute({
    ...request("pair.begin"),
    clientProof: "z".repeat(64),
    token: undefined,
  });
  const isolated: any = await hub.execute({
    ...request("patent.list"),
    clientProof: "z".repeat(64),
    token: connected.token,
  });
  expect(isolated.total).toBe(0);
});

test("concurrent distinct creation requests share the fixed creation allowance", async () => {
  await Promise.all([create("first"), create("second")]);
  expect(await runtime.patents.list("active")).toHaveLength(2);
  expect(hub.state().grants[0]!.createdCount).toBe(2);
});

test("failure inside the creation transaction rolls back patent, quota and ownership together", async () => {
  const recordCreated = hub.ledger.recordCreated.bind(hub.ledger);
  vi.spyOn(hub.ledger, "recordCreated").mockImplementationOnce((...args) => {
    recordCreated(...args);
    throw new Error("simulated transaction failure");
  });
  const result = await call("patent.create", { patentType: "invention", name: "回滚" }, "rollback");
  expect(result.status).toBe("failed");
  expect(await runtime.patents.list("active")).toHaveLength(0);
  expect(hub.state().grants[0]!.createdCount).toBe(0);
  expect(hub.state().grants[0]!.scope.patents).toEqual({});
  expect((await create("retry-after-rollback")).patentId).toBeTypeOf("string");
});

test("post-commit response failure does not lose automatically granted patent access", async () => {
  vi.spyOn(runtime.patents, "release").mockRejectedValueOnce(new Error("response interrupted"));
  const created = await create();
  expect(created.patentId).toBeTypeOf("string");
  expect((await call("patent.read", { patentId: created.patentId })).patent.patentId).toBe(
    created.patentId,
  );
  expect(await create()).toEqual(created);
  expect(hub.state().grants[0]!.createdCount).toBe(1);
});

test("updating a grant preserves identity, invalidates old plans and can remove auto-created rights", async () => {
  const a = await create();
  const plan = await prepare(a.patentId, 0);
  const old = hub.state().grants[0]!;
  const updated = await updateScope({ [a.patentId]: "read" });
  expect(updated.grantId).toBe(old.grantId);
  expect(updated.taskId).toBe(old.taskId);
  expect(updated.createdCount).toBe(1);
  await expect(
    call("change.apply", { patentId: a.patentId, changeId: plan.changeId }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect((await call("pair.begin")).scope.patents[a.patentId]).toBe("read");
  await updateScope({});
  expect((await call("patent.list")).total).toBe(0);
  await expect(
    call("operation.status", { requestId: "create-test", command: "patent.create" }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("downgrade during export cancels publication and old operation cannot expose output", async () => {
  const a = await create();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  exportOverride = async (_p, _v, context) => {
    enter();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    context.assertAuthorized();
    throw new Error("unreachable");
  };
  const result = await call("patent.export", { patentId: a.patentId, expectedRevision: 0 });
  await entered;
  await updateScope({ [a.patentId]: "read" });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: result.operationId })).status).toBe("cancelled"),
  );
  expect((await runtime.patents.captureAutomation(a.patentId)).revision).toBe(0);
});

test("backup failure prevents destructive edits without adding an approval step", async () => {
  const a = await create();
  const plan = await prepare(a.patentId, 0);
  vi.spyOn(runtime.snapshots, "create").mockRejectedValueOnce(new Error("backup unavailable"));
  const result = await call("change.apply", { patentId: a.patentId, changeId: plan.changeId });
  expect(result.status).toBe("failed");
  expect((await runtime.patents.captureAutomation(a.patentId)).revision).toBe(0);
});

test("default workspaces export without directory approval and referenced image reads stay patent scoped", async () => {
  const initial = await updateScope({}, 1, true);
  const a = await create();
  const image = join(initial.scope.workspace.importDirectory, "figure.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), image);
  const imported = (await call("asset.import", { patentId: a.patentId, path: image })).result;
  const plan = await call("change.prepare", {
    patentId: a.patentId,
    expectedRevision: 0,
    operations: [{ type: "attachFigure", assetId: imported.assetId }],
  });
  expect(
    (await call("change.apply", { patentId: a.patentId, changeId: plan.changeId })).status,
  ).toBe("committed");
  const patent = await runtime.patents.captureAutomation(a.patentId);
  const exported = await call("patent.export", {
    patentId: a.patentId,
    expectedRevision: 1,
    format: "patdoc",
    output: join(initial.scope.workspace.exportDirectory, "test.patdoc"),
    acceptWarnings: collectPatentStructureIssues(patent).map((i) => i.kind),
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: exported.operationId })).status).toBe("committed"),
  );
  await updateScope({ [a.patentId]: "read" });
  const asset = await call("asset.read", { patentId: a.patentId, assetId: imported.assetId });
  expect(Buffer.from(asset.data, "base64").length).toBeGreaterThan(0);
  await expect(
    call("asset.read", { patentId: a.patentId, assetId: randomUUID() }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await updateScope({});
  await expect(
    call("asset.read", { patentId: a.patentId, assetId: imported.assetId }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("rolled-back create receipt cannot retain an inaccessible patent ID", async () => {
  const commitReceipt = hub.ledger.inTransaction.bind(hub.ledger);
  vi.spyOn(hub.ledger, "inTransaction").mockImplementation(
    (db, record, status, result, evidence) => {
      commitReceipt(db, record, status, result, evidence);
      if (record.command === "patent.create" && status === "committed")
        throw new Error("receipt commit fault");
    },
  );
  const result = await call(
    "patent.create",
    { patentType: "invention", name: "回执回滚" },
    "receipt-rollback",
  );
  expect(result.status).toBe("failed");
  expect(
    (await call("operation.status", { command: "patent.create", requestId: "receipt-rollback" }))
      .status,
  ).toBe("failed");
  expect(await runtime.patents.list("active")).toHaveLength(0);
  expect(hub.state().grants[0]!.createdCount).toBe(0);
});

test("a diagnostic scope receipt cannot disclose a scope replaced before response delivery", async () => {
  await create();
  const execute = hub.execute.bind(hub);
  vi.spyOn(hub, "execute").mockImplementation(async (input) => {
    const result = await execute(input);
    if (input.command === "doctor") await updateScope({});
    return result;
  });
  const response = await send(
    hub.transport.descriptor!,
    "doctor",
    {},
    { clientProof: proof, token },
    "scope-race",
    1000,
  );
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe("AUTH_CHANGED");
});

test.each(['{"enabled":', "null", '{"enabled":"true"}'])(
  "damaged automation preferences %s fail closed and can be enabled again",
  async (content) => {
    await hub.close();
    const path = join(root, "home", "preferences.json");
    await writeFile(path, content);
    await openHub();
    expect(hub.state().enabled).toBe(false);
    expect(hub.state().instance).toBeNull();
    expect(await readFile(path, "utf8")).toBe(content);
    await hub.control(
      { action: "setEnabled", enabled: true, policyAcceptedVersion: AGENT_CLI_POLICY_VERSION },
      1,
    );
    expect(hub.state().enabled).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      enabled: true,
      policyAcceptedVersion: AGENT_CLI_POLICY_VERSION,
      policyAcceptedAt: expect.any(String),
    });
    expect((await call("pair.begin", { label: "Recovered client" })).status).toBe("pending");
  },
);

test("valid persisted enablement survives restart without restoring the previous client grant", async () => {
  await hub.close();
  await openHub();
  expect(hub.state().enabled).toBe(true);
  expect(hub.state().grants).toEqual([]);
  await expect(call("patent.list")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

async function globalGrant(global: {
  settings?: "read" | "full";
  templates?: "read" | "full";
  models?: "read" | "full";
  library?: "read" | "full";
  documents?: "read" | "full";
}) {
  const grant = hub.state().grants.find((entry) => entry.clientId)!;
  await hub.control(
    { action: "updateGrant", grantId: grant.grantId, scope: { ...grant.scope, global } },
    1,
  );
}
test("global configuration needs an independent domain grant and receipts cannot bypass revocation", async () => {
  await create();
  await expect(call("global.settings.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(call("global.template.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ settings: "read" });
  const current = await call("global.settings.read");
  expect(current.settings.aiCorrection).toBeUndefined();
  expect(current.settings.backup).toBeUndefined();
  expect(current.settings.patentTemplates).toBeUndefined();
  await expect(
    call("global.settings.update", { expectedHash: current.hash, patch: { reducedMotion: true } }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ settings: "full" });
  const payload = { expectedHash: current.hash, patch: { reducedMotion: true } };
  const result = await call("global.settings.update", payload, "global-update");
  expect(result.status).toBe("committed");
  expect((await call("global.settings.read")).settings.reducedMotion).toBe(true);
  expect(await call("global.settings.update", payload, "global-update")).toEqual(result);
  expect((await call("global.settings.update", payload)).status).toBe("failed");
  await expect(
    call("global.settings.update", {
      expectedHash: current.hash,
      patch: { backup: { enabled: false } },
    }),
  ).rejects.toThrow();
  await expect(call("global.template.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({});
  await expect(call("operation.status", { id: result.operationId })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});
test("global templates update is revision checked and commits its receipt atomically", async () => {
  await globalGrant({ templates: "full" });
  const current = await call("global.template.read");
  const payload = {
    expectedRevision: current.catalog.revision,
    catalog: { ...current.catalog, separatePatentTypes: !current.catalog.separatePatentTypes },
    auxiliary: current.auxiliary,
  };
  const result = await call("global.template.update", payload, "template-update");
  expect(result.status).toBe("committed");
  expect((await call("global.template.read")).catalog.revision).toBe(current.catalog.revision + 1);
  expect(await call("global.template.update", payload, "template-update")).toEqual(result);
  expect((await call("global.template.update", payload)).status).toBe("failed");
  await globalGrant({ templates: "read" });
  await expect(call("global.template.update", payload)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});

test("structured books, auxiliary documents and patent settings save together and survive reopening", async () => {
  const created = await create();
  const initial = await runtime.patents.captureAutomation(created.patentId);
  const formula = {
    id: randomUUID(),
    type: "block-formula",
    formulaKind: "math",
    source: "E=mc^2",
  };
  const page = { ...initial.books[0]!.document.page, marginLeftMm: 23 };
  const change = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: initial.revision,
    operations: [
      { type: "replaceBookContent", bookKind: "claims", content: [formula] },
      { type: "setBookPage", bookKind: "claims", page },
      { type: "createAuxiliary", title: "技术交底书", content: [formula], page },
      { type: "setDrawingBooksEnabled", enabled: false },
    ],
  });
  const result = await call(
    "change.apply",
    { patentId: created.patentId, changeId: change.changeId },
    "structured-save",
  );
  expect(result.status).toBe("committed");
  const saved = await runtime.patents.captureAutomation(created.patentId);
  expect(saved.books[0]!.document.content).toEqual([formula]);
  expect(saved.books[0]!.document.page).toEqual(page);
  expect(saved.auxiliaryDocuments[0]!.title).toBe("技术交底书");
  expect(JSON.stringify(saved.auxiliaryDocuments[0]!.editorState)).toContain("E=mc^2");
  expect(saved.auxiliaryDocuments[0]!.persistedRevision).toBe(saved.revision);
  expect(saved.drawingBooksEnabled).toBe(false);
  expect(saved.books.map((book) => book.bookId)).toEqual(initial.books.map((book) => book.bookId));
  const followup = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: saved.revision,
    operations: [
      {
        type: "renameAuxiliary",
        auxiliaryDocumentId: saved.auxiliaryDocuments[0]!.auxiliaryDocumentId,
        title: "交底书终稿",
      },
      { type: "setPatentType", patentType: "utility-model" },
    ],
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: followup.changeId }))
      .status,
  ).toBe("committed");
  const reopened = await runtime.patents.captureAutomation(created.patentId);
  expect(reopened.patentType).toBe("utility-model");
  expect(reopened.drawingBooksEnabled).toBe(true);
  expect(reopened.auxiliaryDocuments[0]!.document.title).toBe("交底书终稿");
  const restore = await call("change.restore-prepare", {
    patentId: created.patentId,
    expectedRevision: reopened.revision,
    revision: initial.revision,
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: restore.changeId })).status,
  ).toBe("committed");
  expect((await runtime.patents.captureAutomation(created.patentId)).auxiliaryDocuments).toEqual(
    [],
  );
});

test("flowchart render stages a linked figure with revision and scope checks", async () => {
  const created = await create();
  const added = await call("flowchart.write", {
    patentId: created.patentId,
    expectedRevision: 0,
    action: "create",
    name: "流程",
    source:
      '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>',
  });
  const project = added.result.projects[0];
  const render = vi.fn(async () => ({
    data: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50" fill="white" stroke="black"/></svg>',
    ).toString("base64"),
    width: 100,
    height: 50,
    mediaType: "image/svg+xml" as const,
    pageId: "p1",
  }));
  graphicOverride = render;
  const input = {
    patentId: created.patentId,
    expectedRevision: 1,
    projectId: project.projectId,
    expectedProjectRevision: project.revision,
  };
  expect(
    (await call("flowchart.render", { ...input, expectedProjectRevision: 99 })).result.error.code,
  ).toBe("REVISION_CONFLICT");
  expect(render).not.toHaveBeenCalled();
  const rendered = await call("flowchart.render", input, "render-flow");
  expect(rendered.status).toBe("committed");
  expect(await call("flowchart.render", input, "render-flow")).toEqual(rendered);
  expect(rendered.result.descriptor.kind).toBe("flowchart-preview");
  const prepared = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: 1,
    operations: [
      {
        type: "attachFlowchartFigure",
        assetId: rendered.result.assetId,
        link: rendered.result.flowchartLink,
        widthMm: rendered.result.outputWidthMm,
      },
    ],
  });
  await call("change.apply", { patentId: created.patentId, changeId: prepared.changeId });
  const patent = await runtime.patents.captureAutomation(created.patentId);
  expect(patent.figures[0]?.flowchartLink?.projectId).toBe(project.projectId);
  await expect(
    call("change.prepare", {
      patentId: created.patentId,
      expectedRevision: patent.revision,
      operations: [
        {
          type: "attachFlowchartFigure",
          assetId: rendered.result.assetId,
          link: { ...rendered.result.flowchartLink, exportedProjectRevision: 99 },
          widthMm: 80,
        },
      ],
    }),
  ).rejects.toThrow();
  await updateScope({ [created.patentId]: "read" });
  await expect(call("flowchart.render", { ...input, expectedRevision: 2 })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await updateScope({ [created.patentId]: "full" });
  graphicOverride = async () => {
    await updateScope({ [created.patentId]: "read" });
    return render();
  };
  await expect(
    call("flowchart.render", { ...input, expectedRevision: patent.revision }),
  ).rejects.toMatchObject({ code: "AUTH_CHANGED" });
});

test("flowchart create save rename duplicate delete is scoped and independent of document snapshots", async () => {
  const created = await create();
  const source =
    '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
  const payload = {
    patentId: created.patentId,
    expectedRevision: 0,
    action: "create",
    name: "工作流程",
    source,
  };
  const added = await call("flowchart.write", payload, "add-flowchart");
  expect(added.status).toBe("committed");
  expect(added.result.projects).toHaveLength(1);
  expect(await call("flowchart.write", payload, "add-flowchart")).toEqual(added);
  const project = added.result.projects[0];
  const loaded = await call("flowchart.read", {
    patentId: created.patentId,
    projectId: project.projectId,
  });
  expect(loaded.source).toContain("mxGraphModel");
  const renamed = await call("flowchart.write", {
    patentId: created.patentId,
    expectedRevision: 1,
    action: "rename",
    projectId: project.projectId,
    expectedProjectRevision: project.revision,
    name: "流程终稿",
  });
  expect(renamed.status).toBe("committed");
  const duplicate = await call("flowchart.write", {
    patentId: created.patentId,
    expectedRevision: 2,
    action: "duplicate",
    projectId: project.projectId,
    name: "流程副本",
  });
  expect(duplicate.result.projects).toHaveLength(2);
  const deleted = await call("flowchart.write", {
    patentId: created.patentId,
    expectedRevision: 3,
    action: "delete",
    projectId: project.projectId,
  });
  expect(deleted.result.projects).toHaveLength(1);
  const restored = await call("change.restore-prepare", {
    patentId: created.patentId,
    expectedRevision: 4,
    revision: 0,
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: restored.changeId }))
      .status,
  ).toBe("committed");
  expect((await call("flowchart.list", { patentId: created.patentId })).items).toHaveLength(1);
  await authorize(false, [created.patentId], false);
  expect(
    (
      await call("flowchart.read", {
        patentId: created.patentId,
        projectId: deleted.result.projects[0].projectId,
      })
    ).project.name,
  ).toBe("流程副本");
  await expect(call("flowchart.write", payload)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await expect(
    call("flowchart.read", { patentId: randomUUID(), projectId: project.projectId }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("invalid flowchart source and receipt failure cannot partially mutate a patent", async () => {
  const created = await create();
  const payload = {
    patentId: created.patentId,
    expectedRevision: 0,
    action: "create",
    name: "流程",
    source: '<mxfile><diagram id="p1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
  };
  const invalid = await call("flowchart.write", {
    ...payload,
    source: '<mxfile><script src="https://invalid.example"/></mxfile>',
  });
  expect(invalid.status).toBe("failed");
  const writeReceipt = hub.ledger.inTransaction.bind(hub.ledger);
  const spy = vi
    .spyOn(hub.ledger, "inTransaction")
    .mockImplementation((db, record, status, result, evidence) => {
      writeReceipt(db, record, status, result, evidence);
      if (record.command === "flowchart.write" && status === "committed")
        throw new Error("receipt fault");
    });
  const failed = await call("flowchart.write", payload);
  expect(failed.status).toBe("failed");
  spy.mockRestore();
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(0);
  expect((await call("flowchart.list", { patentId: created.patentId })).items).toEqual([]);
});

test("search uses only authorized saved books and auxiliary content without leaking other patents", async () => {
  const a = await create();
  await updateScope({ [a.patentId]: "full" }, 2);
  const b = (await call("patent.create", { name: "未授权专利的机密词", patentType: "invention" }))
    .result;
  const edit = await call("change.prepare", {
    patentId: a.patentId,
    expectedRevision: 0,
    operations: [{ type: "createAuxiliary", title: "独有交底词", content: [] }],
  });
  expect(
    (await call("change.apply", { patentId: a.patentId, changeId: edit.changeId })).status,
  ).toBe("committed");
  await updateScope({ [a.patentId]: "read" });
  expect((await call("patent.search", { query: "独有交底词" })).items).toHaveLength(1);
  expect((await call("patent.search", { query: "机密词" })).items).toEqual([]);
  await expect(
    call("patent.search", { query: "机密词", patentIds: [b.patentId] }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("staged assets are usable in structured auxiliary content and export without escaping patent ownership", async () => {
  const created = await create();
  const image = join(root, "structured.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), image);
  const asset = (await call("asset.import", { patentId: created.patentId, path: image })).result;
  const block = {
    id: randomUUID(),
    type: "figure",
    assetId: asset.assetId,
    widthMm: 40,
    alignment: "center",
  };
  const plan = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: 0,
    operations: [
      { type: "useAsset", assetId: asset.assetId },
      { type: "createAuxiliary", title: "交底附图", content: [block] },
    ],
  });
  expect(
    (await call("change.apply", { patentId: created.patentId, changeId: plan.changeId })).status,
  ).toBe("committed");
  const saved = await runtime.patents.captureAutomation(created.patentId);
  const auxiliaryDocumentId = saved.auxiliaryDocuments[0]!.auxiliaryDocumentId;
  const output = join(root, "auxiliary.docx");
  const receipt = await call("patent.export", {
    patentId: created.patentId,
    expectedRevision: saved.revision,
    auxiliaryDocumentId,
    format: "docx",
    output,
  });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: receipt.operationId })).status).toBe("committed"),
  );
  expect((await stat(output)).size).toBeGreaterThan(100);
  await updateScope({ [created.patentId]: "full" }, 2);
  const other = (await call("patent.create", { name: "另一专利", patentType: "invention" })).result;
  await expect(
    call("change.prepare", {
      patentId: other.patentId,
      expectedRevision: 0,
      operations: [
        { type: "useAsset", assetId: asset.assetId },
        { type: "createAuxiliary", title: "越界", content: [block] },
      ],
    }),
  ).rejects.toThrow();
});

test("model configuration and credentials require their own grant and never return key contents", async () => {
  await globalGrant({ settings: "full" });
  await expect(call("global.models.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ models: "read" });
  const current = await call("global.models.read");
  await expect(
    call("global.models.set-key", { profileId: randomUUID(), apiKey: "example-test-key" }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await globalGrant({ models: "full" });
  const profileId = randomUUID();
  const config = {
    ...current.settings.aiCorrection,
    profiles: [
      {
        profileId,
        providerId: "deepseek",
        displayName: "测试模型",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
      },
    ],
    activeProfileId: profileId,
  };
  const result = await call("global.models.update", {
    expectedHash: current.hash,
    patch: { aiCorrection: config, aiConnectionsEnabled: false },
  });
  expect(result.status).toBe("committed");
  expect((await call("capabilities")).inputSchema.modelSettingsPatch).toBeTruthy();
  const saved = await call(
    "global.models.set-key",
    { profileId, apiKey: "example-test-key" },
    "model-key",
  );
  expect(saved.status, JSON.stringify(saved)).toBe("committed");
  expect(saved.result).toEqual({ profileId, hasApiKey: true });
  const state = await call("global.models.read");
  expect(state.credentialProfileIds).toEqual([profileId]);
  expect(JSON.stringify(state)).not.toContain("example-test-key");
  const receipt = hub.ledger.byId(
    saved.clientId ?? hub.state().grants[0]!.clientId,
    saved.operationId,
  );
  expect(JSON.stringify(receipt)).not.toContain("example-test-key");
  expect((await call("global.models.clear-key", { profileId })).status).toBe("committed");
  expect((await call("global.models.read")).credentialProfileIds).toEqual([]);
  await globalGrant({});
  await expect(call("operation.status", { id: saved.operationId })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});

test("full-library transfer requires its own domain and publishes one replay-safe encrypted package", async () => {
  await create();
  const setGlobal = async (global: Record<string, "read" | "full">) => {
    const grant = hub.state().grants[0]!;
    await hub.control(
      { action: "updateGrant", grantId: grant.grantId, scope: { ...grant.scope, global } },
      1,
    );
  };
  const exportPackage = vi.fn<NonNullable<AutomationHubOptions["transfer"]>["exportPackage"]>(
    async (request) => {
      await writeFile(request.finalPath, "encrypted fixture");
      return {
        operationId: request.operationId,
        finalPath: request.finalPath,
        displayPath: "private",
        sizeBytes: 17,
        cutoffAt: new Date().toISOString(),
        packageFormatVersion: 2,
        fullVerificationPassed: true,
        warnings: [],
        summary: {
          activePatents: 1,
          trashedPatents: 0,
          documents: 0,
          legacyDrafts: 0,
          snapshots: 1,
          assets: 0,
          flowchartProjects: 0,
          totalBytes: 17,
        },
      };
    },
  );
  transferOverride = { inspect: async () => ({ empty: false }), exportPackage };
  await setGlobal({
    library: "full",
    models: "full",
    settings: "full",
    templates: "full",
    documents: "full",
  });
  await expect(call("global.transfer.read")).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await setGlobal({ transfer: "read" });
  expect(await call("global.transfer.read")).toEqual({ empty: false });
  const output = join(root, "complete.zxwbackup");
  const input = {
    output,
    password: "test-package-password",
    passwordRecorded: true,
    persisted: true,
  };
  await expect(call("global.transfer.export", input)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await setGlobal({ transfer: "full" });
  const task = await call("global.transfer.export", input, "complete-export");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: task.operationId })).status).toBe("committed"),
  );
  expect(await readFile(output, "utf8")).toBe("encrypted fixture");
  expect((await call("global.transfer.export", input, "complete-export")).status).toBe("committed");
  expect(exportPackage).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(hub.ledger.byId(hub.state().grants[0]!.clientId, task.operationId)),
  ).not.toContain(input.password);
});

test("conversation history and mutations obey patent scope and preserve interrupted-write evidence", async () => {
  const created = await create();
  const read = vi.fn(() => ({ items: [] }));
  const run: NonNullable<AutomationHubOptions["conversations"]>["run"] = vi.fn(
    async (_patent, _payload, context) => {
      context.begin();
      throw new Error("interrupted history write");
    },
  );
  conversationsOverride = { read, run };
  await updateScope({ [created.patentId]: "read" });
  expect((await call("ai.conversation.read", { patentId: created.patentId })).items).toEqual([]);
  await expect(call("ai.conversation.read", { patentId: randomUUID() })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  const payload = {
    patentId: created.patentId,
    expectedRevision: 0,
    action: "start",
    scope: { kind: "generation", bookKind: "description" },
    instruction: "生成",
  };
  await expect(call("ai.conversation.run", payload)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  expect(run).not.toHaveBeenCalled();
  await updateScope({ [created.patentId]: "full" });
  const task = await call("ai.conversation.run", payload, "interrupted-conversation");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: task.operationId })).status).toBe(
      "recovery_required",
    ),
  );
  expect((await call("ai.conversation.run", payload, "interrupted-conversation")).status).toBe(
    "recovery_required",
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});

test("AI tasks capture one authorized revision, replay receipts and abort on scope downgrade", async () => {
  const created = await create();
  const run = vi.fn(async (_command, patent) => ({
    patentId: patent.patentId,
    revision: patent.revision,
    result: { generatedText: "候选文字" },
  }));
  aiOverride = run;
  const payload = {
    patentId: created.patentId,
    expectedRevision: 0,
    scope: { kind: "generation", bookKind: "claims" },
    requirement: "起草权利要求",
  };
  const task = await call("ai.polish", payload, "ai-draft");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: task.operationId })).status).toBe("committed"),
  );
  expect((await call("ai.polish", payload, "ai-draft")).status).toBe("committed");
  expect(run).toHaveBeenCalledTimes(1);
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(0);
  let signal: AbortSignal | undefined;
  aiOverride = async (_command, _patent, _payload, context) => {
    signal = context.signal;
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    context.assertAuthorized();
    return {};
  };
  const pending = await call("ai.polish", payload);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await updateScope({ [created.patentId]: "read" });
  expect(signal?.aborted).toBe(true);
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: pending.operationId })).status).toBe("cancelled"),
  );
});

test("CLI scientific renders preserve requested resolution and editable chemical source", async () => {
  const { patentId } = await create();
  const formula = await call("asset.render-formula", {
    patentId,
    latex: "x^2+y^2",
    outputWidthMm: 100,
  });
  expect(formula.status).toBe("committed");
  expect(formula.result.descriptor.widthPx).toBeCloseTo((100 * 300) / 25.4, -1);
  const source = {
    ketSource:
      '{"root":{"nodes":[{"$ref":"mol0"}]},"mol0":{"type":"molecule","atoms":[{"label":"C"}],"bonds":[]}}',
    editorMode: "molecule",
  };
  const chemical = await call("asset.render-chemistry", {
    patentId,
    source,
    outputWidthMm: 100,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M10 10L60 40" stroke="black"/></svg>',
  });
  expect(chemical.status).toBe("committed");
  expect(chemical.result.descriptor.widthPx).toBeCloseTo((100 * 300) / 25.4, -1);
  const stored = await runtime.assetStore.readAsset(chemical.result.assetId);
  expect(readChemicalStructureSource(Buffer.from(stored.original).toString("utf8"))).toEqual(
    source,
  );
  const prepared = await call("change.prepare", {
    patentId,
    expectedRevision: 0,
    operations: [
      { type: "attachFigure", assetId: chemical.result.assetId, widthMm: 100 },
      {
        type: "insertBlock",
        bookKind: "description",
        afterBlockId: null,
        block: {
          id: randomUUID(),
          type: "chemical-structure",
          ...source,
          previewAssetId: chemical.result.assetId,
          widthMm: 100,
          alignment: "center",
        },
      },
    ],
  });
  expect((await call("change.apply", { patentId, changeId: prepared.changeId })).status).toBe(
    "committed",
  );
  const saved = await runtime.patents.captureAutomation(patentId);
  const path = join(root, "editable-chemical.patdoc");
  await writePatdoc(path, { patent: saved, assets: [stored] });
  const restored = await readPatdoc<PatentPatdocPayload>(path);
  expect(
    readChemicalStructureSource(Buffer.from(restored.assets[0]!.original).toString("utf8")),
  ).toEqual(source);
  expect(
    restored.patent.books.find((book) => book.kind === "description")?.document.content[0],
  ).toMatchObject({ ketSource: source.ketSource });
});

test("CLI rejects invalid formula and chemical sources without staging assets", async () => {
  const { patentId } = await create();
  const formula = await call("asset.render-formula", { patentId, latex: String.raw`\frac{1}{` });
  expect(formula.status).toBe("failed");
  expect(formula.result.error).toMatchObject({
    code: "INVALID_FORMULA",
    message: expect.stringContaining("公式语法错误"),
  });
  const chemical = await call("asset.render-chemistry", {
    patentId,
    source: { ketSource: "not KET or JSON" },
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M10 10L60 40" stroke="black"/></svg>',
  });
  expect(chemical.status).toBe("failed");
  expect(hub.state().stagedAssetCount).toBe(0);
});

test.each(["book", "auxiliary"])(
  "CLI refuses malformed chemical blocks in %s while keeping the saved patent unchanged",
  async (target) => {
    const created = await create();
    const chemical = await call("asset.render-chemistry", {
      patentId: created.patentId,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M10 10L60 40" stroke="black"/></svg>',
    });
    await expect(
      call("change.prepare", {
        patentId: created.patentId,
        expectedRevision: created.revision,
        operations: [
          { type: "useAsset", assetId: chemical.result.assetId },
          ...(target === "auxiliary"
            ? [
                {
                  type: "createAuxiliary",
                  title: "结构测试",
                  content: [
                    {
                      id: randomUUID(),
                      type: "chemical-structure",
                      ketSource: "not KET or JSON",
                      previewAssetId: chemical.result.assetId,
                      widthMm: 80,
                      alignment: "center",
                    },
                  ],
                },
              ]
            : [
                {
                  type: "insertBlock",
                  bookKind: "description",
                  afterBlockId: null,
                  block: {
                    id: randomUUID(),
                    type: "chemical-structure",
                    ketSource: "not KET or JSON",
                    previewAssetId: chemical.result.assetId,
                    widthMm: 80,
                    alignment: "center",
                  },
                },
              ]),
        ],
      }),
    ).rejects.toThrow();
    expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(
      created.revision,
    );
  },
);

test("generated formula and chemical assets stay scoped until an explicit atomic change", async () => {
  const created = await create();
  const formulaInput = { patentId: created.patentId, latex: "x^2 + y^2 = z^2" };
  const formula = (await call("asset.render-formula", formulaInput, "formula")).result;
  expect(formula.descriptor.kind).toBe("image");
  expect((await call("asset.render-formula", formulaInput, "formula")).result).toEqual(formula);
  expect((await runtime.patents.captureAutomation(created.patentId)).assets).toHaveLength(0);
  const preview = await call("asset.preview", { assetHandle: formula.assetHandle });
  expect(Buffer.from(preview.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><path d="M10 10L60 40" stroke="black"/></svg>';
  const chemical = (await call("asset.render-chemistry", { patentId: created.patentId, svg }))
    .result;
  expect(chemical.descriptor.kind).toBe("chemical-preview");
  const unsafe = await call("asset.render-chemistry", {
    patentId: created.patentId,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/private"/></svg>',
  });
  expect(unsafe.status).toBe("failed");
  expect(hub.state().stagedAssetCount).toBe(2);
  const change = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: created.revision,
    operations: [{ type: "attachFigure", assetId: formula.assetId }],
  });
  const applied = await call("change.apply", {
    patentId: created.patentId,
    changeId: change.changeId,
  });
  const output = join(root, "formula.png");
  const exported = await call(
    "asset.export",
    {
      patentId: created.patentId,
      expectedRevision: applied.result.revision,
      assetId: formula.assetId,
      variant: "original",
      output,
    },
    "formula-export",
  );
  expect(exported.status).toBe("committed");
  expect(await readFile(output)).toEqual(
    Buffer.from((await runtime.assetStore.readAsset(formula.assetId)).original),
  );
  expect(
    (
      await call("asset.export", {
        patentId: created.patentId,
        expectedRevision: applied.result.revision,
        assetId: chemical.assetId,
        output: join(root, "uncommitted.png"),
      })
    ).result.error.code,
  ).toBe("SCOPE_DENIED");
  await authorize(false, [created.patentId], false);
  for (const command of ["asset.render-formula", "asset.render-chemistry", "asset.export"] as const)
    await expect(call(command, { patentId: created.patentId })).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  await expect(call("asset.preview", { assetHandle: chemical.assetHandle })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("flowchart file import and export use scoped directories and atomic receipts", async () => {
  const created = await create();
  const source =
    '<mxfile><diagram id="page-one" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  const path = join(root, "示意图.drawio");
  await writeFile(path, source);
  const input = {
    patentId: created.patentId,
    expectedRevision: created.revision,
    action: "import",
    path,
  };
  const imported = await call("flowchart.write", input, "flow-file");
  expect(imported.status).toBe("committed");
  expect((await call("flowchart.write", input, "flow-file")).result.revision).toBe(
    imported.result.revision,
  );
  const project = imported.result.projects[0];
  const output = join(root, "export.drawio");
  const receipt = await call("flowchart.export", {
    patentId: created.patentId,
    expectedRevision: imported.result.revision,
    projectId: project.projectId,
    output,
  });
  expect(receipt.status).toBe("committed");
  expect(await readFile(output, "utf8")).toContain("mxGraphModel");
  const conflict = await call("flowchart.export", {
    patentId: created.patentId,
    expectedRevision: imported.result.revision,
    projectId: project.projectId,
    output,
  });
  expect(conflict.result.error.code).toBe("OUTPUT_EXISTS");
  expect(
    (
      await call("flowchart.export", {
        patentId: created.patentId,
        expectedRevision: imported.result.revision,
        projectId: randomUUID(),
        output: join(root, "foreign.drawio"),
      })
    ).status,
  ).toBe("failed");
});

test("inspection exposes built-in rule choices without modifying persisted defaults", async () => {
  const created = await create();
  await authorize(false, [created.patentId], false);
  const capabilities = await call("capabilities");
  expect(capabilities.inspectionRules.length).toBeGreaterThan(1);
  const ruleId = capabilities.inspectionRules[0].id;
  const report = await call("patent.inspect", {
    patentId: created.patentId,
    ruleIds: [ruleId],
    mode: "full",
  });
  expect(report.issues.every((issue: { ruleId: string }) => issue.ruleId === ruleId)).toBe(true);
  await expect(
    call("patent.inspect", { patentId: created.patentId, ruleIds: ["unknown.rule"] }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect((await runtime.patents.captureAutomation(created.patentId)).revision).toBe(
    created.revision,
  );
});

test("drawing import and project editing persist independently of document history restoration", async () => {
  const created = await create();
  const image = join(root, "drawing.png");
  await copyFile(resolve("tests/fixtures/images/sample.png"), image);
  const imported = await call(
    "drawing.import",
    { patentId: created.patentId, path: image },
    "drawing-import",
  );
  expect(imported.status, JSON.stringify(imported)).toBe("committed");
  expect(imported.result.assets).toHaveLength(2);
  const project = imported.result.project;
  const change = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: created.revision,
    operations: [
      ...imported.result.assets.map((asset: { assetId: string }) => ({
        type: "useAsset",
        assetId: asset.assetId,
      })),
      { type: "createDrawingProject", project },
    ],
  });
  expect(change.diff.drawingProjects.after).toHaveLength(1);
  const applied = await call("change.apply", {
    patentId: created.patentId,
    changeId: change.changeId,
  });
  expect(applied.status).toBe("committed");
  const saved = await runtime.patents.captureAutomation(created.patentId);
  expect(saved.drawingProjects[0]?.sourceAssetId).toBe(project.sourceAssetId);
  const savedProject = saved.drawingProjects[0]!;
  const edit = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: saved.revision,
    operations: [
      {
        type: "updateDrawingProject",
        projectId: savedProject.projectId,
        expectedProjectRevision: 0,
        project: {
          ...project,
          name: "修改工作稿",
          annotations: [
            { id: "label-1", text: "1", x: 10, y: 10, fontSize: 12, lineWidth: 1, points: [] },
          ],
        },
      },
    ],
  });
  const updated = await call("change.apply", {
    patentId: created.patentId,
    changeId: edit.changeId,
  });
  expect(updated.status).toBe("committed");
  expect(
    (await runtime.patents.captureAutomation(created.patentId)).drawingProjects[0]?.revision,
  ).toBe(1);
  await expect(
    call("change.prepare", {
      patentId: created.patentId,
      expectedRevision: updated.result.revision,
      operations: [
        {
          type: "deleteDrawingProject",
          projectId: savedProject.projectId,
          expectedProjectRevision: 0,
        },
      ],
    }),
  ).rejects.toThrow("revision");
  await expect(
    call("change.prepare", {
      patentId: created.patentId,
      expectedRevision: updated.result.revision,
      operations: [
        { type: "createDrawingProject", project: { ...project, sourceAssetId: randomUUID() } },
      ],
    }),
  ).rejects.toThrow();
  const deletion = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: updated.result.revision,
    operations: [
      {
        type: "deleteDrawingProject",
        projectId: savedProject.projectId,
        expectedProjectRevision: 1,
      },
    ],
  });
  const deleted = await call("change.apply", {
    patentId: created.patentId,
    changeId: deletion.changeId,
  });
  expect((await runtime.patents.captureAutomation(created.patentId)).drawingProjects).toHaveLength(
    0,
  );
  const restore = await call("change.restore-prepare", {
    patentId: created.patentId,
    expectedRevision: deleted.result.revision,
    revision: 0,
  });
  expect(restore.diff.restoration.after.drawingProjects).toEqual([]);
  await call("change.apply", { patentId: created.patentId, changeId: restore.changeId });
  expect((await runtime.patents.captureAutomation(created.patentId)).drawingProjects).toEqual([]);
});

test("native import creates a separately scoped patent without transferring local history", async () => {
  const { writePatdoc } = await import("../documents/patdoc-writer.js");
  const { collectPatdocHistory } = await import("../documents/collect-patdoc-history.js");
  const created = await create();
  const change = await call("change.prepare", {
    patentId: created.patentId,
    expectedRevision: created.revision,
    operations: [{ type: "createAuxiliary", title: "实验材料", content: [] }],
  });
  await call("change.apply", { patentId: created.patentId, changeId: change.changeId });
  const source = await runtime.patents.captureAutomation(created.patentId);
  const file = join(root, "完整原生专利.patdoc");
  await writePatdoc(file, {
    patent: source,
    assets: [],
    flowcharts: [],
    snapshots: await collectPatdocHistory(source.patentId, runtime.snapshots, runtime.assetStore),
  });
  await authorize(false, [source.patentId], true);
  const input = { path: file, format: "patdoc" };
  const accepted = await call("patent.import", input, "native-import");
  let imported: any;
  await vi.waitFor(async () => {
    imported = await call("operation.status", { id: accepted.operationId });
    expect(imported.status, JSON.stringify(imported)).toBe("committed");
  });
  const importedId = imported.result.patents[0].patentId;
  expect(importedId).not.toBe(source.patentId);
  const read = await call("patent.read", { patentId: importedId });
  expect(read.patent.auxiliaryDocuments[0].title).toBe("实验材料");
  expect(await runtime.snapshots.list(importedId)).toHaveLength(1);
  expect(read.patent.docxImportReport).toBeNull();
  expect((await call("patent.import", input, "native-import")).result).toEqual(imported.result);
  expect(await runtime.patents.list("active")).toHaveLength(2);
  await expect(prepare(source.patentId, source.revision)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  expect(await runtime.patents.captureAutomation(source.patentId)).toEqual(source);
  for (let i = 0; i < 4; i++) await create(`native-import-quota-${i}`);
  const extra = await call("patent.import", { ...input, allowDuplicate: true }, "over-limit");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: extra.operationId })).status).toBe("failed"),
  );
  expect(await runtime.patents.list("active")).toHaveLength(6);
});

test("import rolls back every new patent when receipt persistence fails", async () => {
  const { writePatdoc } = await import("../documents/patdoc-writer.js");
  const created = await create();
  const source = await runtime.patents.captureAutomation(created.patentId);
  const file = join(root, "rollback.patdoc");
  await writePatdoc(file, { patent: source, assets: [], flowcharts: [] });
  await authorize(false, [], true);
  const originalReceipt = hub.ledger.inTransaction.bind(hub.ledger);
  const receipt = vi
    .spyOn(hub.ledger, "inTransaction")
    .mockImplementation((database, record, status, result, evidence) => {
      if (status === "committed") throw new Error("receipt failure");
      return originalReceipt(database, record, status, result, evidence);
    });
  const accepted = await call("patent.import", { path: file, format: "patdoc" });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: accepted.operationId })).status).toBe("failed"),
  );
  receipt.mockRestore();
  expect(await runtime.patents.list("active")).toHaveLength(1);
  expect(hub.state().grants[0]?.createdCount).toBe(0);
});

test("bundle import commits all new scopes together and checks quota before any patent is added", async () => {
  const { createBlankPatent } = await import("../../shared/patent/defaults.js");
  const { writePatdoc } = await import("../documents/patdoc-writer.js");
  const { writePatentBundle } = await import("../documents/patent-bundle.js");
  const items = [];
  for (const index of [1, 2]) {
    const path = join(root, `${index}.patdoc`);
    const patent = createBlankPatent({ patentType: "invention", name: `包内专利${index}` });
    await writePatdoc(path, { patent, assets: [], flowcharts: [] });
    items.push({ name: patent.name!, file: path, native: path });
  }
  const path = join(root, "two.zip");
  await writePatentBundle(path, "patdoc", items);
  for (let i = 0; i < 4; i++) await create(`bundle-quota-${i}`);
  const denied = await call("patent.import", { path, format: "bundle" }, "insufficient-quota");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: denied.operationId })).status).toBe("failed"),
  );
  expect(await runtime.patents.list("active")).toHaveLength(4);
  const renewal = await call("pair.renew-create");
  await hub.control(
    {
      action: "approvePair",
      pairId: renewal.pairId,
      scope: { patents: {}, createLimit: 5, workspace: {} },
    },
    1,
  );
  const accepted = await call("patent.import", { path, format: "bundle" }, "bundle-ok");
  let receipt: any;
  await vi.waitFor(async () => {
    receipt = await call("operation.status", { id: accepted.operationId });
    expect(receipt.status, JSON.stringify(receipt)).toBe("committed");
  });
  expect(receipt.result.patents).toHaveLength(2);
  for (const patent of receipt.result.patents)
    expect((await call("patent.read", { patentId: patent.patentId })).patent.patentId).toBe(
      patent.patentId,
    );
  const duplicate = await call("patent.import", { path, format: "bundle" }, "duplicate");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: duplicate.operationId })).result.error.code).toBe(
      "DUPLICATE_IMPORT",
    ),
  );
  expect(await runtime.patents.list("active")).toHaveLength(6);
});

test("explicit history creation and deletion keep revision checks and the last recovery anchor", async () => {
  const created = await create();
  const change = await prepare(created.patentId, created.revision);
  const applied = await call("change.apply", {
    patentId: created.patentId,
    changeId: change.changeId,
  });
  const payload = { patentId: created.patentId, expectedRevision: applied.result.revision };
  const saved = await call("history.create", payload, "snapshot-create");
  expect(saved.status, JSON.stringify(saved)).toBe("committed");
  expect(saved.result.revision).toBe(payload.expectedRevision);
  expect((await call("history.create", payload, "snapshot-create")).result).toEqual(saved.result);
  const deleted = await call("history.delete", { ...payload, revision: 0 }, "snapshot-delete");
  expect(deleted.status, JSON.stringify(deleted)).toBe("committed");
  expect(
    (await runtime.snapshots.list(created.patentId)).map((snapshot) => snapshot.revision),
  ).toEqual([payload.expectedRevision]);
  expect(
    (await call("history.delete", { ...payload, revision: payload.expectedRevision })).result.error
      .code,
  ).toBe("SNAPSHOT_RECOVERY_PROTECTED");
  expect(
    (await call("history.create", { ...payload, expectedRevision: 0 })).result.error.code,
  ).toBe("REVISION_CONFLICT");
  await authorize(false, [created.patentId], false);
  for (const command of ["history.create", "history.delete"] as const)
    await expect(call(command, payload)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});

test("snapshot and receipt roll back together when the atomic hook fails", async () => {
  const created = await create();
  const change = await prepare(created.patentId, created.revision);
  const applied = await call("change.apply", {
    patentId: created.patentId,
    changeId: change.changeId,
  });
  const originalReceipt = hub.ledger.inTransaction.bind(hub.ledger);
  const receipt = vi
    .spyOn(hub.ledger, "inTransaction")
    .mockImplementation((database, record, status, result, evidence) => {
      if (
        evidence &&
        typeof evidence === "object" &&
        "kind" in evidence &&
        evidence.kind === "snapshot-create"
      )
        throw new Error("snapshot receipt failure");
      return originalReceipt(database, record, status, result, evidence);
    });
  const saved = await call("history.create", {
    patentId: created.patentId,
    expectedRevision: applied.result.revision,
  });
  expect(saved.status, JSON.stringify(saved)).toBe("failed");
  receipt.mockRestore();
  expect(
    (await runtime.snapshots.list(created.patentId)).map((snapshot) => snapshot.revision),
  ).toEqual([0]);
});

test("revoking a grant during snapshot work prevents the queued snapshot write", async () => {
  const created = await create();
  const change = await prepare(created.patentId, created.revision);
  const applied = await call("change.apply", {
    patentId: created.patentId,
    changeId: change.changeId,
  });
  const grant = hub.state().grants[0]!;
  const original = runtime.snapshots.create.bind(runtime.snapshots);
  vi.spyOn(runtime.snapshots, "create").mockImplementationOnce(async (id, source, context) => {
    await hub.control({ action: "revoke", grantId: grant.grantId }, 1);
    return original(id, source, context);
  });
  await expect(
    call(
      "history.create",
      { patentId: created.patentId, expectedRevision: applied.result.revision },
      "revoke-snapshot",
    ),
  ).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  expect(
    (await runtime.snapshots.list(created.patentId)).map((snapshot) => snapshot.revision),
  ).toEqual([0]);
  expect(hub.ledger.read(grant.clientId, "history.create", "revoke-snapshot")?.status).toBe(
    "cancelled",
  );
});

test.each([true, false])(
  "trashed patents cannot be authorized or operated until GUI restoration (task owned: %s)",
  async (owned) => {
    const created = await create();
    if (!owned) await authorize(true, [created.patentId], false);
    const prepared = await prepare(created.patentId, created.revision);
    const trashed = await call(
      "patent.trash",
      { patentId: created.patentId, expectedRevision: created.revision },
      "trash",
    );
    expect(trashed.status).toBe("committed");
    expect((await call("operation.status", { id: trashed.operationId })).status).toBe("committed");
    expect(hub.state().grants[0]?.scope.patents[created.patentId]).toBeUndefined();
    expect((await call("patent.list", { scope: "trash" })).items).toHaveLength(0);
    expect((await call("patent.list")).items).toHaveLength(0);
    const deletedAt = (await runtime.patents.list("trash"))[0]!.deletedAt!;
    for (const command of [
      "patent.read",
      "patent.inspect",
      "history.list",
      "patent.restore",
      "patent.delete",
      "change.apply",
    ] as const)
      await expect(
        call(command, {
          patentId: created.patentId,
          expectedDeletedAt: deletedAt,
          changeId: prepared.changeId,
        }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    for (const full of [true, false])
      await expect(authorize(full, [created.patentId], false)).rejects.toMatchObject({
        code: "INVALID_SCOPE",
      });
    await runtime.patents.restore(created.patentId, { expectedDeletedAt: deletedAt });
    await authorize(true, [created.patentId], false);
    expect((await call("patent.read", { patentId: created.patentId })).patent.patentId).toBe(
      created.patentId,
    );
  },
);

test("trash deletion rolls back when its atomic receipt fails and rejects untracked open leases", async () => {
  const created = await create();
  const opened = await runtime.patents.open(created.patentId);
  const input = { patentId: created.patentId, expectedRevision: created.revision };
  expect((await call("patent.trash", input, "leased")).result.error.code).toBe("LIBRARY_LOCKED");
  await runtime.patents.release(opened.sessionId);
  const original = hub.ledger.inTransaction.bind(hub.ledger);
  const receipt = vi
    .spyOn(hub.ledger, "inTransaction")
    .mockImplementation((database, record, status, result, evidence) => {
      if (record.command === "patent.trash" && status === "committed")
        throw new Error("receipt failed");
      return original(database, record, status, result, evidence);
    });
  expect((await call("patent.trash", input, "rollback-trash")).status).toBe("failed");
  receipt.mockRestore();
  expect(await runtime.patents.list("active")).toHaveLength(1);
  expect(await runtime.patents.list("trash")).toHaveLength(0);
});

test("legacy drafts migrate atomically once with separate document permission", async () => {
  const draftId = randomUUID();
  legacyOverride = {
    list: async () => [
      {
        draftId,
        displayName: "旧草稿",
        savedAt: new Date().toISOString(),
        originalPath: null,
        documentId: draftId,
      },
    ],
    open: async () => ({
      document: createBlankDocument("迁入旧草稿"),
      assets: [],
      settings: {},
      editorState: {},
    }),
    isImported: async () => false,
  };
  await expect(call("global.documents.legacy.read")).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  const grant = hub.state().grants[0]!;
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { ...grant.scope, global: { documents: "read" } },
    },
    1,
  );
  expect((await call("global.documents.legacy.read")).entries).toHaveLength(1);
  await expect(call("global.documents.legacy.import", { draftId })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { ...grant.scope, global: { documents: "full" } },
    },
    1,
  );
  const task = await call("global.documents.legacy.import", { draftId }, "legacy-once");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: task.operationId })).status).toBe("committed"),
  );
  const result = (await call("operation.status", { id: task.operationId })).result;
  expect(runtime.library.captureAutomation(result.documentId).document.title).toBe("迁入旧草稿");
  expect(hub.legacyDraftImported(draftId)).toBe(true);
  expect((await call("global.documents.legacy.read")).entries).toEqual([]);
  expect((await call("global.documents.legacy.import", { draftId }, "legacy-once")).status).toBe(
    "committed",
  );
  const again = await call("global.documents.legacy.import", { draftId });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: again.operationId })).status).toBe("failed"),
  );
  expect(await runtime.library.list("active", true)).toHaveLength(1);
});

test.each([false, true])(
  "full-import handoff requires a durable scheduling receipt (receipt failure=%s)",
  async (receiptFailure) => {
    transferOverride = { inspect: async () => ({}), exportPackage: vi.fn() };
    const commit = vi.fn<NonNullable<AutomationHubOptions["transferImport"]>["commit"]>(
      async (_id, detach) => {
        await detach();
      },
    );
    transferImportOverride = {
      prepare: vi.fn(async (_path, _password, operationId) => ({
        operationId,
        packageId: randomUUID(),
        exportedAt: new Date().toISOString(),
        summary: {
          activePatents: 0,
          trashedPatents: 0,
          documents: 0,
          legacyDrafts: 0,
          snapshots: 0,
          assets: 0,
          flowchartProjects: 0,
          totalBytes: 0,
        },
        packageVerified: true as const,
        versionCompatible: true as const,
        targetLibraryEmpty: true as const,
        settingsRequiringSetup: ["backup-folder", "ai-credentials", "printer"] as const,
      })),
      discard: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      commit,
      fail: vi.fn(async () => {}),
    };
    const grant = hub.state().grants[0]!;
    await hub.control(
      {
        action: "updateGrant",
        grantId: grant.grantId,
        scope: { ...grant.scope, global: { transfer: "full" } },
      },
      1,
    );
    const path = join(root, "package.zxwbackup");
    await writeFile(path, "fixture");
    const task = await call("global.transfer.import.prepare", { path, password: "password" });
    await vi.waitFor(async () =>
      expect((await call("operation.status", { id: task.operationId })).status).toBe("committed"),
    );
    const prepared = (await call("operation.status", { id: task.operationId })).result;
    const update = hub.ledger.update.bind(hub.ledger);
    if (receiptFailure)
      vi.spyOn(hub.ledger, "update").mockImplementation((record, status, ...args) => {
        if (record.command === "global.transfer.import.commit" && status === "committed")
          throw new Error("scheduling receipt persistence failure");
        return update(record, status, ...args);
      });
    const response = await send(
      hub.transport.descriptor!,
      "global.transfer.import.commit",
      { importId: prepared.importId, restart: true },
      { clientProof: proof, token },
      randomUUID(),
      1000,
    );
    if (receiptFailure) {
      expect(response).toMatchObject({ ok: true, value: { status: "failed" } });
      expect(commit).not.toHaveBeenCalled();
      expect(transferImportOverride.fail).toHaveBeenCalledWith(prepared.importId);
      expect(hub.transport.descriptor).not.toBeNull();
      expect(
        hub.transferImports?.read(prepared.importId, {
          grantId: grant.grantId,
          importDirectory: root,
          assertAuthorized: () => {},
        }),
      ).toBeDefined();
      return;
    }
    expect(response).toMatchObject({
      ok: true,
      value: { status: "committed", result: { phase: "scheduled" } },
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(hub.transport.descriptor).toBeNull());
  },
);

test.each([false, true])(
  "relocation enforces scope and durable restart scheduling (receipt failure=%s)",
  async (receiptFailure) => {
    transferOverride = { inspect: async () => ({}), exportPackage: vi.fn() };
    const restart = vi.fn();
    const ready = vi.fn();
    const schedule = vi.fn(async (parent) => join(parent, "new-library"));
    relocationOverride = { schedule, assertReady: ready, restart, cancel: vi.fn(async () => {}) };
    await expect(
      call("global.transfer.relocate", { parent: root, restart: true }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const grant = hub.state().grants[0]!;
    await hub.control(
      {
        action: "updateGrant",
        grantId: grant.grantId,
        scope: { ...grant.scope, global: { transfer: "full" } },
      },
      1,
    );
    await expect(
      call("global.transfer.relocate", { parent: "/", restart: true }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    ready.mockImplementationOnce(() => {
      throw new Error("editor open");
    });
    await expect(call("global.transfer.relocate", { parent: root, restart: true })).rejects.toThrow(
      "editor open",
    );
    const update = hub.ledger.update.bind(hub.ledger);
    if (receiptFailure)
      vi.spyOn(hub.ledger, "update").mockImplementation((record, status, ...args) => {
        if (record.command === "global.transfer.relocate" && status === "committed")
          throw new Error("relocation receipt persistence failure");
        return update(record, status, ...args);
      });
    const response = await send(
      hub.transport.descriptor!,
      "global.transfer.relocate",
      { parent: root, restart: true },
      { clientProof: proof, token },
      "move-once",
      1000,
    );
    if (receiptFailure) {
      expect(response).toMatchObject({ ok: true, value: { status: "recovery_required" } });
      expect(restart).not.toHaveBeenCalled();
      expect(relocationOverride.cancel).toHaveBeenCalledOnce();
      expect(hub.transport.descriptor).not.toBeNull();
      return;
    }
    expect(response).toMatchObject({
      ok: true,
      value: {
        status: "committed",
        result: { phase: "scheduled", target: join(root, "new-library") },
      },
    });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    await call("global.transfer.relocate", { parent: root, restart: true }, "move-once");
    expect(schedule).toHaveBeenCalledOnce();
  },
);

test("independent document printing honors its domain and records uncertain spooler results without replay", async () => {
  const grant = hub.state().grants[0]!;
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { ...grant.scope, global: { documents: "full" } },
    },
    1,
  );
  const document = (await call("global.documents.create", { title: "独立文档打印" })).result;
  const defaults = createDefaultPrintSettings();
  const submit = vi.fn<NonNullable<AutomationHubOptions["printing"]>["submit"]>(async (...args) => {
    args[5]?.();
    throw new Error("spooler connection lost");
  });
  printingOverride = {
    printers: async () => [
      {
        deviceName: "fixture-printer",
        displayName: "Fixture",
        description: null,
        duplex: "unknown",
        color: "unknown",
        paperSize: "unknown",
      },
    ],
    submit,
  };
  const input = {
    documentId: document.documentId,
    expectedRevision: 0,
    layout: defaults.layout,
    output: { ...defaults.output, printerDeviceName: "fixture-printer" },
    acceptWarnings: [],
  };
  const result = await call("global.documents.print", input, "document-print-once");
  expect(result.status).toBe("recovery_required");
  expect((await call("global.documents.print", input, "document-print-once")).status).toBe(
    "recovery_required",
  );
  expect(submit).toHaveBeenCalledOnce();
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { ...grant.scope, global: { documents: "read" } },
    },
    1,
  );
  await expect(call("global.documents.print", input)).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
});

test("model probes need explicit full model permission and do not repeat uncertain external requests", async () => {
  const profileId = randomUUID();
  const probe = vi.fn<NonNullable<AutomationHubOptions["probeModel"]>>(
    async (_action, id, _signal, assertAuthorized, begin) => {
      assertAuthorized();
      begin();
      return { profileId: id, connected: true };
    },
  );
  probeOverride = probe;
  await expect(call("global.models.test-connection", { profileId })).rejects.toMatchObject({
    code: "SCOPE_DENIED",
  });
  const grant = hub.state().grants[0]!;
  await hub.control(
    {
      action: "updateGrant",
      grantId: grant.grantId,
      scope: { ...grant.scope, global: { models: "full" } },
    },
    1,
  );
  const task = await call("global.models.test-connection", { profileId }, "model-probe");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: task.operationId })).status).toBe("committed"),
  );
  expect(
    (await call("global.models.test-connection", { profileId }, "model-probe")).result.connected,
  ).toBe(true);
  expect(probe).toHaveBeenCalledOnce();
  probe.mockImplementationOnce(async (_action, _id, _signal, _assert, begin) => {
    begin();
    throw new Error("connection lost");
  });
  const interrupted = await call("global.models.discover", { profileId }, "model-discovery");
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: interrupted.operationId })).status).toBe(
      "recovery_required",
    ),
  );
  await call("global.models.discover", { profileId }, "model-discovery");
  expect(probe).toHaveBeenCalledTimes(2);
});

test("pair requests expose declared intent only to GUI and never grant it automatically", async () => {
  await hub.control({ action: "revoke", grantId: hub.state().grants[0]!.grantId }, 1);
  token = "";
  const requested = {
    task: "新建测试并参考已有专利",
    createLimit: 2,
    patents: [{ name: "某专利", access: "read" }],
    global: { settings: "full" },
  };
  const pair = await call("pair.begin", { requested });
  expect(hub.state().pendingPairs[0]?.requested).toEqual(requested);
  expect(hub.state().grants).toHaveLength(0);
  await expect(call("patent.list")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  await call("pair.begin", { requested: { createLimit: 100 } });
  expect(hub.state().pendingPairs[0]?.requested).toEqual(requested);
  await hub.control(
    {
      action: "approvePair",
      pairId: pair.pairId,
      scope: { patents: {}, createLimit: 1, workspace: {} },
    },
    1,
  );
  token = (await call("pair.poll")).token;
  expect((await call("doctor")).scope).toMatchObject({ patents: {}, createLimit: 5 });
  expect((await call("doctor")).scope.global).toBeUndefined();
});
test("invalid requested scope fails before creating a pending request", async () => {
  await hub.control({ action: "revoke", grantId: hub.state().grants[0]!.grantId }, 1);
  token = "";
  await expect(call("pair.begin", { requested: { createLimit: 101 } })).rejects.toThrow();
  expect(hub.state().pendingPairs).toHaveLength(0);
});
test("workspace selection requires an authorized client and changes only the user-confirmed directory", async () => {
  const chooser = vi.fn(async () => root);
  workspaceOverride = chooser;
  token = "";
  await expect(
    call("workspace.select", { kind: "export", directory: "/unconfirmed" }),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(chooser).not.toHaveBeenCalled();
  await authorize(true, [], true, []);
  const before = (await call("doctor")).scope;
  const selected = await call("workspace.select", { kind: "export", directory: "/unconfirmed" });
  expect(selected).toMatchObject({
    status: "selected",
    directory: root,
    scope: {
      createLimit: before.createLimit,
      workspace: { importDirectory: before.workspace.importDirectory, exportDirectory: root },
    },
  });
  expect(selected.scope.patents).toEqual(before.patents);
  expect(chooser).toHaveBeenCalledWith("export", "/unconfirmed", "Test agent");
  workspaceOverride = async () => null;
  expect(await call("workspace.select", { kind: "import" })).toEqual({
    status: "cancelled",
    kind: "import",
  });
  expect((await call("doctor")).scope.workspace).toEqual(selected.scope.workspace);
});
test("duplicate location requests are rejected and late user confirmation cannot revive revoked permission", async () => {
  await authorize();
  let finish!: (path: string) => void;
  workspaceOverride = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = call("workspace.select", { kind: "export" });
  const rejected = expect(pending).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  await expect(call("workspace.select", { kind: "import" })).rejects.toMatchObject({
    code: "BUSY",
  });
  await hub.control({ action: "revoke", grantId: hub.state().grants[0]!.grantId }, 1);
  finish(root);
  await rejected;
  expect(hub.state().grants).toHaveLength(0);
});
test("an active file operation blocks workspace changes without opening another dialog", async () => {
  const created = await create();
  let start!: () => void;
  const entered = new Promise<void>((resolve) => {
    start = resolve;
  });
  exportOverride = async (_patent, _payload, context) => {
    start();
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    context.assertAuthorized();
    return {};
  };
  const chooser = vi.fn(async () => root);
  workspaceOverride = chooser;
  const exporting = await call(
    "patent.export",
    {
      patentId: created.patentId,
      expectedRevision: created.revision,
      format: "pdf",
      output: join(root, "busy.pdf"),
    },
    "workspace-busy",
  );
  await entered;
  await expect(call("workspace.select", { kind: "export" })).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(chooser).not.toHaveBeenCalled();
  await call("operation.cancel", { id: exporting.operationId });
  await vi.waitFor(async () =>
    expect((await call("operation.status", { id: exporting.operationId })).status).toBe(
      "cancelled",
    ),
  );
});

test("creation grants are fixed at five; renewal preserves task authority and deduplicates pending requests", async () => {
  const initial = await call("doctor");
  expect(initial.scope.createLimit).toBe(5);
  await expect(call("pair.renew-create")).rejects.toMatchObject({ code: "INVALID_SCOPE" });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await create(`quota-${i}`)).patentId);
  const denied = await call(
    "patent.create",
    { patentType: "invention", name: "第六件" },
    "quota-six",
  );
  expect(denied).toMatchObject({ status: "failed", result: { error: { code: "SCOPE_DENIED" } } });
  expect(await runtime.patents.list("active")).toHaveLength(5);
  expect((await call("doctor")).creationRemaining).toBe(0);
  const plan = await prepare(ids[0]!, 0);
  const renewal = await call("pair.renew-create");
  expect((await call("pair.renew-create")).pairId).toBe(renewal.pairId);
  expect(hub.state().pendingPairs[0]?.creationRenewal).toBe(true);
  expect((await call("pair.poll", { id: renewal.pairId })).status).toBe("pending");
  await hub.control({ action: "rejectPair", pairId: renewal.pairId }, 1);
  await expect(call("pair.poll", { id: renewal.pairId })).rejects.toMatchObject({
    code: "PAIR_EXPIRED",
  });
  expect((await call("patent.read", { patentId: ids[0] })).patent.patentId).toBe(ids[0]);
  const next = await call("pair.renew-create");
  await hub.control(
    {
      action: "approvePair",
      pairId: next.pairId,
      scope: { patents: {}, createLimit: 5, workspace: {}, global: { settings: "full" } },
    },
    1,
  );
  const approved = await call("pair.poll", { id: next.pairId });
  expect(approved).toMatchObject({
    status: "authorized",
    taskId: initial.taskId,
    creationRemaining: 5,
  });
  expect(approved.scope.global?.settings).toBeUndefined();
  expect(approved.scope.workspace).toEqual(initial.scope.workspace);
  expect((await call("change.inspect", { changeId: plan.changeId })).changeId).toBe(plan.changeId);
  for (let i = 0; i < 5; i++) expect((await create(`renewal-quota-${i}`)).patentId).toBeDefined();
  expect((await call("doctor")).creationRemaining).toBe(0);
  expect(await runtime.patents.list("active")).toHaveLength(10);
  const extra = await call("patent.create", { patentType: "invention", name: "第十一件" });
  expect(extra.status).toBe("failed");
  const grant = hub.state().grants[0]!;
  await hub.control(
    { action: "updateGrant", grantId: grant.grantId, scope: { ...grant.scope, createLimit: 0 } },
    1,
  );
  await hub.control(
    { action: "updateGrant", grantId: grant.grantId, scope: { ...grant.scope, createLimit: 5 } },
    1,
  );
  expect((await call("doctor")).creationRemaining).toBe(0);
  await expect(
    hub.control(
      { action: "updateGrant", grantId: grant.grantId, scope: { ...grant.scope, createLimit: 6 } },
      1,
    ),
  ).rejects.toThrow();
});

test("concurrent creation cannot exceed five and revoking a pending renewal prevents approval", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      call("patent.create", { patentType: "invention", name: `并发${i}` }, `parallel-quota-${i}`),
    ),
  );
  expect(results.filter((r) => r.status === "committed")).toHaveLength(5);
  expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
  expect(await runtime.patents.list("active")).toHaveLength(5);
  const renewal = await call("pair.renew-create");
  const grant = hub.state().grants[0]!;
  await hub.control({ action: "revoke", grantId: grant.grantId }, 1);
  expect(hub.state().pendingPairs).toHaveLength(0);
  await expect(
    hub.control(
      {
        action: "approvePair",
        pairId: renewal.pairId,
        scope: { patents: {}, createLimit: 5, workspace: {} },
      },
      1,
    ),
  ).rejects.toThrow();
});

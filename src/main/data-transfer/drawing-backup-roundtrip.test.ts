import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AssetDescriptorSchema } from "../../shared/document/model.js";
import { drawingProjectFixture } from "../../shared/drawing-markup/test-fixture.js";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PATENT_TEMPLATE_SETTINGS,
} from "../../shared/settings/model.js";
import { packDrawingTiles, validateDrawingContainer } from "../assets/drawing-tiles.js";
import { FileService } from "../documents/file-service.js";
import { DraftService } from "../drafts/draft-service.js";
import { LibraryMigrationService } from "../library/library-migration-service.js";
import { createLibraryRuntime } from "../library/library-runtime.js";
import { DataImportJournal } from "./data-import-journal.js";
import { DataImportRecoveryService } from "./data-import-recovery-service.js";
import { FullDataExportService } from "./full-data-export-service.js";
import { FullDataImportService } from "./full-data-import-service.js";
import { ImportStagingValidator } from "./import-staging-validator.js";
import { LibraryImportSwapCoordinator } from "./library-import-swap-coordinator.js";
import { PackageReader, TransferSourceHandle } from "./package-reader.js";

const roots: string[] = [];
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const password = "synthetic backup password 123456";
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each([
  { tiled: false, unified: false },
  { tiled: true, unified: false },
  { tiled: false, unified: true },
])(
  "full encrypted backup restores live graphics while document snapshots stay workspace-free (tiled=$tiled unified=$unified)",
  async ({ tiled, unified }) => {
    const root = await mkdtemp(join(tmpdir(), "drawing-backup-roundtrip-"));
    roots.push(root);
    const sourceLibrary = join(root, "source-library");
    const sourceUser = join(root, "source-user");
    const work = join(root, "work");
    const destination = join(root, "backup");
    await mkdir(work);
    await mkdir(destination);
    const source = await createLibraryRuntime({
      libraryRoot: sourceLibrary,
      userDataRoot: sourceUser,
      readOnly: false,
      runRecovery: true,
      startBackgroundSchedulers: false,
    });
    const created = await source.patents.create({
      patentType: "utility-model",
      name: "Drawing backup fixture",
      templates: DEFAULT_PATENT_TEMPLATE_SETTINGS,
    });
    let original = new Uint8Array(await readFile(resolve("tests/fixtures/images/sample.png")));
    let preview = original;
    if (tiled) {
      const tilesRoot = join(root, "tiles");
      await mkdir(tilesRoot);
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000000 800000"><rect width="1000000" height="800000" fill="white"/><circle cx="500000" cy="400000" r="120000" fill="none" stroke="black" stroke-width="1000"/></svg>',
      );
      const rectangle = { x: 0, y: 0, width: 1000, height: 800 };
      await writeFile(join(tilesRoot, "tile-0.svg"), svg);
      await writeFile(
        join(tilesRoot, "index.json"),
        JSON.stringify({
          version: 1,
          width: 1000,
          height: 800,
          tier: "large",
          primitives: 1,
          tiles: [
            {
              id: "tile-0",
              core: rectangle,
              render: rectangle,
              byteLength: svg.length,
              sha256: createHash("sha256").update(svg).digest("hex").toUpperCase(),
            },
          ],
        }),
      );
      const packed = await packDrawingTiles(tilesRoot);
      original = new Uint8Array(packed.container);
      preview = new Uint8Array(packed.preview);
    }
    const digest = createHash("sha256").update(original).digest("hex").toUpperCase();
    const installed = await source.assetStore.install(
      { kind: "patent", patentId: created.patentId },
      {
        descriptor: {
          assetId: id,
          ...(tiled
            ? {
                kind: "drawing-tiles" as const,
                originalName: "unpublished.cadtiles",
                mediaType: "application/vnd.zxw.cad-tiles+zip" as const,
                extension: "cadtiles" as const,
              }
            : {
                kind: "image" as const,
                originalName: "unpublished.png",
                mediaType: "image/png" as const,
                extension: "png" as const,
              }),
          byteLength: original.length,
          sha256: digest,
          widthPx: 1000,
          heightPx: 800,
          previewByteLength: preview.length,
          previewSha256: createHash("sha256").update(preview).digest("hex").toUpperCase(),
        },
        original,
        preview,
      },
    );
    const cadBytes = new Uint8Array(Buffer.from("AC1032 synthetic DWG persistence fixture"));
    const cad = await source.assetStore.install(
      { kind: "patent", patentId: created.patentId },
      {
        descriptor: {
          ...installed.descriptor,
          assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
          kind: "drawing-source",
          originalName: "source.dwg",
          mediaType: "image/vnd.dwg",
          extension: "dwg",
          byteLength: cadBytes.length,
          sha256: createHash("sha256").update(cadBytes).digest("hex").toUpperCase(),
        },
        original: cadBytes,
        preview,
      },
    );
    const project = drawingProjectFixture(installed.descriptor.assetId);
    project.sourceAssetId = cad.descriptor.assetId;
    project.sourceKind = "dwg";
    const assets = [installed.descriptor, cad.descriptor];
    const unifiedAssets = [];
    if (unified) {
      for (const [assetId, kind, extension, bytes] of [
        [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
          "drawing-source",
          "dxf",
          Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"),
        ],
        [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad",
          "vector-image",
          "svg",
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><path d="M10 10L50 50" stroke="blue"/></svg>',
          ),
        ],
      ] as const) {
        const item = await source.assetStore.install(
          { kind: "patent", patentId: created.patentId },
          {
            descriptor: AssetDescriptorSchema.parse({
              ...installed.descriptor,
              assetId,
              kind,
              extension,
              mediaType: extension === "svg" ? "image/svg+xml" : "image/vnd.dxf",
              originalName: `unified.${extension}`,
              byteLength: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
            }),
            original: new Uint8Array(bytes),
            preview,
          },
        );
        assets.push(item.descriptor);
        unifiedAssets.push({ descriptor: item.descriptor, original: new Uint8Array(bytes) });
      }
      project.cad = {
        version: 1,
        engine: "cadcraft",
        engineVersion: "0".repeat(40),
        assetId: unifiedAssets[0]!.descriptor.assetId,
        mapping: { originX: 0, originY: 800, scale: 1 },
        unified: 1,
        objects: [{ id: project.annotations[0]!.id, kind: "label", label: ["A", "B"] }],
        overlayAssetId: unifiedAssets[1]!.descriptor.assetId,
        backgroundSize: [1000, 800],
        semanticKey: "0".repeat(16),
      };
    }
    const transformedFragment = project.baseFragments?.[1];
    if (!transformedFragment) throw new Error("Missing fixture fragment");
    transformedFragment.scale = 1.3;
    transformedFragment.rotation = 30;
    await source.patents.applyFigureEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: 0,
      figures: [],
      assets,
      abstractDrawingFigureId: null,
      drawingProjects: [project],
    });
    // Exercise the real linked-image path together with CAD in the unified case.
    if (unified) {
      const flowchart = await source.flowcharts.create({
        patentId: created.patentId,
        expectedPatentRevision: 1,
        name: "独立流程图",
        source: Buffer.from('<mxfile><diagram id="p1">editable</diagram></mxfile>'),
        pageCount: 1,
        lastPageId: "p1",
      });
      const preview = await source.flowcharts.renderPreview({
        patentId: created.patentId,
        projectId: flowchart.project.projectId,
        expectedProjectRevision: flowchart.project.revision,
        expectedSourceSha256: flowchart.project.sourceSha256,
        pageId: "p1",
        exportScope: "page",
        selectedCellIds: [],
        borderMm: 2,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="2" y="2" width="96" height="46" fill="white" stroke="black"/></svg>',
        target: { kind: "new", insertIndex: 0 },
      });
      await source.flowcharts.commitPreview({
        patentId: created.patentId,
        sessionId: created.sessionId,
        expectedPatentRevision: flowchart.patentRevision,
        projectId: flowchart.project.projectId,
        previewToken: preview.previewToken,
      });
    }
    const beforeSnapshot = source.patents.loadSavedPatent(created.patentId);
    const snapshot = await source.snapshots.create(created.patentId, "manual-create");
    const modified = structuredClone(project);
    for (const annotation of modified.annotations) annotation.text = "99";
    modified.revision++;
    await source.patents.applyFigureEdit({
      patentId: created.patentId,
      sessionId: created.sessionId,
      expectedRevision: beforeSnapshot.revision,
      figures: beforeSnapshot.figures,
      assets: beforeSnapshot.assets,
      abstractDrawingFigureId: null,
      drawingProjects: [modified],
    });
    const finalPath = join(destination, "state.zxwbackup");
    try {
      await new FullDataExportService({
        applicationVersion: "0.1.0",
        database: source.database,
        libraryRoot: sourceLibrary,
        userDataRoot: sourceUser,
        workRoot: work,
        draftService: new DraftService(join(sourceUser, "drafts")),
        fileService: new FileService(),
        settingsService: { read: async () => structuredClone(DEFAULT_APP_SETTINGS) },
        quiescence: { acquire: async () => ({ release: async () => {} }) },
      }).export({ operationId, finalPath, password, passwordHint: null, passwordRecorded: true });
    } finally {
      await source.close();
    }
    const reader = await PackageReader.open(finalPath);
    try {
      await reader.unlock(password);
      expect((await reader.scanManifest()).canonicalPatentFormatVersion).toBe(
        unified ? 15 : tiled ? 13 : 12,
      );
    } finally {
      await reader.close();
    }

    const libraryRoot = join(root, "target-library");
    const userDataRoot = join(root, "target-user");
    const applicationDataRoot = join(root, "target-app");
    const target = await new LibraryMigrationService(libraryRoot).prepare();
    if (target.status !== "ready") throw new Error("fixture target unavailable");
    await mkdir(applicationDataRoot);
    await mkdir(join(userDataRoot, "drafts"), { recursive: true });
    await writeFile(join(userDataRoot, "settings.json"), JSON.stringify(DEFAULT_APP_SETTINGS));
    const importer = new FullDataImportService({
      libraryRoot,
      userDataRoot,
      applicationDataRoot,
      inspector: { inspect: async () => ({ empty: true, blockers: [] }) },
      resolveSourceSelection: async (selectionId) => ({
        selectionId,
        sourceHandle: await TransferSourceHandle.open(finalPath),
      }),
      readCurrentSettings: async () => structuredClone(DEFAULT_APP_SETTINGS),
    });
    try {
      await importer.prepareImport({ operationId, sourceSelectionId: "synthetic", password });
      const lease = await importer.takePreparedImportLease(operationId);
      if (!lease) throw new Error("prepared lease missing");
      const journal = new DataImportJournal({ applicationDataRoot, libraryRoot, userDataRoot });
      const result = await new LibraryImportSwapCoordinator({
        libraryRoot,
        userDataRoot,
        applicationDataRoot,
        prepared: lease.prepared,
        lease,
        journal,
        ensureCurrentState: async () => {},
        inspectEmptyLibrary: async () => ({ empty: true, blockers: [] }),
        closeRuntime: async () => {
          target.database.close();
        },
        validateStaging: async (prepared) =>
          new ImportStagingValidator().validate(
            {
              installed: true,
              libraryRoot: prepared.stagingLibraryPath,
              userDataRoot: dirname(prepared.stagingDraftsPath),
              packageRoot: join(
                prepared.libraryStagingCapability.root,
                (await readdir(prepared.libraryStagingCapability.root)).find((name) =>
                  name.startsWith(".package-extract-"),
                ) ?? "missing-extraction",
              ),
              portableSettingsRoot: join(
                prepared.userDataStagingCapability.root,
                (await readdir(prepared.userDataStagingCapability.root)).find((name) =>
                  name.startsWith(".package-extract-"),
                ) ?? "missing-extraction",
              ),
              legacyDraftsRoot: prepared.stagingDraftsPath,
              ...(prepared.stagingPolishHistoryPath
                ? { polishHistoryRoot: prepared.stagingPolishHistoryPath }
                : {}),
              installedDatabaseIntegrity: {
                byteLength: Number(prepared.stagingDatabaseIntegrity.size),
                sha256: prepared.stagingDatabaseIntegrity.sha256,
              },
            },
            prepared.manifest,
          ),
      }).commit();
      expect(
        (
          await new DataImportRecoveryService({
            journal,
            libraryRoot,
            userDataRoot,
            applicationDataRoot,
          }).recover()
        ).status,
      ).toBe("recovered");
      await result.releaseHandoff.release();
      const restored = await createLibraryRuntime({
        libraryRoot,
        userDataRoot,
        readOnly: false,
        runRecovery: true,
        startBackgroundSchedulers: false,
      });
      try {
        const opened = await restored.patents.open(created.patentId);
        expect(opened.patent.drawingProjects).toEqual([modified]);
        expect(opened.patent.figures).toEqual(beforeSnapshot.figures);
        expect(opened.patent.flowchartProjects).toEqual(beforeSnapshot.flowchartProjects);
        for (const flowchart of opened.patent.flowchartProjects)
          expect(
            Buffer.from(
              restored.flowcharts.load(created.patentId, flowchart.projectId).source,
            ).toString(),
          ).toContain("editable");
        expect(
          (await restored.assetStore.readAsset(installed.descriptor.assetId)).original,
        ).toEqual(original);
        expect((await restored.assetStore.readAsset(cad.descriptor.assetId)).original).toEqual(
          cadBytes,
        );
        for (const item of unifiedAssets)
          expect((await restored.assetStore.readAsset(item.descriptor.assetId)).original).toEqual(
            item.original,
          );
        if (tiled)
          expect(
            (
              await validateDrawingContainer(
                (
                  await restored.assetStore.readAsset(installed.descriptor.assetId)
                ).original,
              )
            ).tiles,
          ).toHaveLength(1);
        const earlier = await restored.snapshots.open(created.patentId, snapshot.revision);
        expect(earlier.patent.drawingProjects).toHaveLength(0);
        expect(earlier.patent.flowchartProjects).toHaveLength(0);
        expect(earlier.patent.figures[0]?.flowchartLink).toBeUndefined();
        // CAD no longer pins resources in document history; the active undo session still does.
        await restored.patents.applyFigureEdit({
          patentId: created.patentId,
          sessionId: opened.sessionId,
          expectedRevision: opened.revision,
          figures: [],
          assets: [],
          abstractDrawingFigureId: null,
          drawingProjects: [],
        });
        await restored.assetStore.collectUnreferenced({
          kind: "patent",
          patentId: created.patentId,
        });
        expect(
          (await restored.snapshots.open(created.patentId, snapshot.revision)).patent
            .drawingProjects,
        ).toHaveLength(0);
        expect(
          (await restored.assetStore.readAsset(installed.descriptor.assetId)).original,
        ).toEqual(original);
        expect((await restored.assetStore.readAsset(cad.descriptor.assetId)).original).toEqual(
          cadBytes,
        );
        for (const item of unifiedAssets)
          expect((await restored.assetStore.readAsset(item.descriptor.assetId)).original).toEqual(
            item.original,
          );
        await restored.patents.release(opened.sessionId);
        await expect(restored.assetStore.readAsset(cad.descriptor.assetId)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect(
          (await restored.snapshots.open(created.patentId, snapshot.revision)).patent
            .drawingProjects,
        ).toHaveLength(0);
      } finally {
        await restored.close();
      }
    } finally {
      target.database.close();
    }
  },
  30_000, // Encrypted roundtrip plus native, identity-pinned Windows cleanup.
);

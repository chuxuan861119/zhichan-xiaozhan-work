import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test } from "./helpers/workbench.js";

const MEBIBYTE = 1024 * 1024;
const ASSET_COUNT = 12;
const BITMAP_WIDTH = 4_096;
const BITMAP_HEIGHT = 3_669;
const BITMAP_BYTES = 54 + BITMAP_WIDTH * BITMAP_HEIGHT * 3;
const PERFORMANCE_PASSWORD = "虚构性能迁移口令用于门禁甲乙";

async function beginMainRssSampling(application: ElectronApplication): Promise<number> {
  return await application.evaluate(() => {
    const holder = globalThis as typeof globalThis & {
      fullTransferRss?: number[];
      fullTransferRssTimer?: ReturnType<typeof setInterval>;
    };
    holder.fullTransferRss = [process.memoryUsage().rss];
    holder.fullTransferRssTimer = setInterval(() => {
      holder.fullTransferRss?.push(process.memoryUsage().rss);
    }, 50);
    return holder.fullTransferRss[0] ?? 0;
  });
}

async function endMainRssSampling(application: ElectronApplication): Promise<number[]> {
  return await application.evaluate(() => {
    const holder = globalThis as typeof globalThis & {
      fullTransferRss?: number[];
      fullTransferRssTimer?: ReturnType<typeof setInterval>;
    };
    if (holder.fullTransferRssTimer) clearInterval(holder.fullTransferRssTimer);
    const samples = holder.fullTransferRss ?? [];
    delete holder.fullTransferRss;
    delete holder.fullTransferRssTimer;
    return samples;
  });
}

function maximumEventsPerSecond(timestamps: readonly number[]): number {
  let maximum = 0;
  let start = 0;
  for (let end = 0; end < timestamps.length; end += 1) {
    const timestamp = timestamps[end];
    if (timestamp === undefined) continue;
    while (timestamps[start] !== undefined && timestamp - (timestamps[start] ?? 0) >= 1_000) {
      start += 1;
    }
    maximum = Math.max(maximum, end - start + 1);
  }
  return maximum;
}

test.describe("@performance full data transfer", () => {
  test("streams at least 512 MiB within memory, progress and renderer-response gates", async ({
    workbench,
  }) => {
    test.setTimeout(900_000);
    expect(ASSET_COUNT * BITMAP_BYTES).toBeGreaterThanOrEqual(512 * MEBIBYTE);
    const outputPath = join(workbench.root, "虚构512MiB性能迁移.zxwbackup");
    const application = await workbench.launch();
    try {
      await application.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: path }),
        });
      }, outputPath);
      const page = await application.firstWindow();
      const seededBytes = await page.evaluate(
        async ({ assetCount, width, height }) => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          const created = await api.patents.create({
            patentType: "invention",
            name: "虚构512MiB迁移性能库",
            customer: null,
          });
          if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
          const patent = created.value.patent;
          const descriptors = [];
          const pixelBytes = width * height * 3;
          for (let index = 0; index < assetCount; index += 1) {
            const bytes = new Uint8Array(54 + pixelBytes);
            const view = new DataView(bytes.buffer);
            bytes[0] = 0x42;
            bytes[1] = 0x4d;
            view.setUint32(2, bytes.byteLength, true);
            view.setUint32(10, 54, true);
            view.setUint32(14, 40, true);
            view.setInt32(18, width, true);
            view.setInt32(22, height, true);
            view.setUint16(26, 1, true);
            view.setUint16(28, 24, true);
            view.setUint32(34, pixelBytes, true);
            const pattern = new Uint8Array(32_749);
            let state = 0x9e3779b9 ^ index;
            for (let offset = 0; offset < pattern.byteLength; offset += 1) {
              state ^= state << 13;
              state ^= state >>> 17;
              state ^= state << 5;
              pattern[offset] = state & 0xff;
            }
            for (let offset = 54; offset < bytes.byteLength; offset += pattern.byteLength) {
              bytes.set(
                pattern.subarray(0, Math.min(pattern.byteLength, bytes.byteLength - offset)),
                offset,
              );
            }
            const imported = await api.assets.importBytes({
              sessionId: created.value.sessionId,
              originalName: `虚构性能资源-${String(index + 1).padStart(2, "0")}.bmp`,
              declaredMediaType: "image/bmp",
              bytes,
            });
            if (!imported.ok) throw new Error(`asset import failed: ${imported.error.code}`);
            descriptors.push(imported.value.descriptor);
          }
          const description = patent.books.find((book) => book.kind === "description");
          if (!description) throw new Error("description book missing");
          const edited = await api.patents.applyBookEdit({
            patentId: created.value.patentId,
            sessionId: created.value.sessionId,
            bookKind: "description",
            expectedRevision: patent.revision,
            document: {
              ...description.document,
              content: descriptors.map((descriptor, index) => ({
                id: `00000000-0000-4000-8000-${String(940_000 + index).padStart(12, "0")}`,
                type: "figure" as const,
                assetId: descriptor.assetId,
                widthMm: 20,
                alignment: "center" as const,
              })),
            },
            editorState: {},
            assets: descriptors,
          });
          if (!edited.ok) throw new Error(`book edit failed: ${edited.error.code}`);
          const flushed = await api.patents.flush({
            patentId: created.value.patentId,
            expectedRevision: edited.value.revision,
          });
          if (!flushed.ok) throw new Error(`flush failed: ${flushed.error.code}`);
          const released = await api.patents.release(created.value.sessionId);
          if (!released.ok) throw new Error(`release failed: ${released.error.code}`);
          return assetCount * (54 + pixelBytes);
        },
        { assetCount: ASSET_COUNT, width: BITMAP_WIDTH, height: BITMAP_HEIGHT },
      );
      expect(seededBytes).toBeGreaterThanOrEqual(512 * MEBIBYTE);

      const baselineRss = await beginMainRssSampling(application);
      const exportPromise = page.evaluate(
        async ({ operationId, password }) => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          const progressTimestamps: number[] = [];
          const unsubscribe = api.dataTransfer.onProgress(() =>
            progressTimestamps.push(performance.now()),
          );
          try {
            const selected = await api.dataTransfer.selectExportDestination();
            if (!selected.ok || !selected.value) throw new Error("destination selection failed");
            const result = await api.dataTransfer.exportPackage({
              operationId,
              destinationSelectionId: selected.value.selectionId,
              password,
              passwordHint: "虚构性能提示",
              passwordRecorded: true,
            });
            return { result, progressTimestamps };
          } finally {
            unsubscribe();
          }
        },
        { operationId: randomUUID(), password: PERFORMANCE_PASSWORD },
      );

      const responsivenessStarted = Date.now();
      let rendererProbes = 0;
      while (Date.now() - responsivenessStarted < 2_000) {
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        rendererProbes += 1;
      }
      const exported = await exportPromise;
      const rssSamples = await endMainRssSampling(application);
      if (!exported.result.ok) {
        throw new Error(`performance export failed: ${exported.result.error.code}`);
      }
      const peakRss = Math.max(...rssSamples);
      const relativePeakRss = peakRss - baselineRss;
      const progressEventsPerSecond = maximumEventsPerSecond(exported.progressTimestamps);
      const packageBytes = (await stat(outputPath)).size;
      console.log(
        `FULL_DATA_TRANSFER_PERFORMANCE ${JSON.stringify({ seededBytes, packageBytes, baselineRss, peakRss, relativePeakRss, progressEventsPerSecond, rendererProbes })}`,
      );

      expect(packageBytes).toBeGreaterThan(512 * MEBIBYTE);
      expect(relativePeakRss).toBeLessThan(256 * MEBIBYTE);
      expect(progressEventsPerSecond).toBeLessThanOrEqual(12);
      expect(rendererProbes).toBeGreaterThanOrEqual(10);
    } finally {
      await application.close().catch(() => undefined);
    }
  });
});

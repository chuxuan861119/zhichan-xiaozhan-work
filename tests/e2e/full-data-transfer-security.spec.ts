import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArchivePathPolicy,
  assertSafeExtractionTargetMetadata,
} from "../../src/main/data-transfer/archive-path-policy.js";
import {
  PackageReader,
  type PackageReaderErrorCode,
} from "../../src/main/data-transfer/package-reader.js";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import {
  createV1MinimalPackageFixture,
  V1_FIXTURE_PASSWORD,
} from "../fixtures/data-transfer/v1-minimal-package.fixture.js";
import { dismissWorkbenchWelcome, expect, test } from "./helpers/workbench.js";

async function readerFailure(path: string, password = V1_FIXTURE_PASSWORD) {
  const reader = await PackageReader.open(path);
  try {
    await reader.readPublicHeader();
    await reader.unlock(password);
    await reader.scanManifest();
    return null;
  } catch (error) {
    return error as { code?: PackageReaderErrorCode; message?: string };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function mutateHeaderNumber(bytes: Buffer, before: string, after: string): Buffer {
  if (Buffer.byteLength(before) !== Buffer.byteLength(after)) {
    throw new Error("header mutation must preserve byte length");
  }
  const changed = Buffer.from(bytes);
  const offset = changed.indexOf(before, 0, "utf8");
  if (offset < 0) throw new Error("header mutation target missing");
  changed.write(after, offset, "utf8");
  expect(changed.equals(bytes)).toBe(false);
  return changed;
}

test.describe("full data transfer security gates", () => {
  test("non-empty library blocks before any package picker or package read", async ({
    workbench,
  }) => {
    const application = await workbench.launch();
    try {
      const page = await application.firstWindow();
      await dismissWorkbenchWelcome(page);
      await page.evaluate(async () => {
        const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
        const created = await api.patents.create({
          patentType: "invention",
          name: "虚构非空库安全门禁",
          customer: null,
        });
        if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
        await api.patents.release(created.value.sessionId);
      });
      await application.evaluate(({ dialog }) => {
        const holder = globalThis as typeof globalThis & { transferPickerCalls?: number };
        holder.transferPickerCalls = 0;
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => {
            holder.transferPickerCalls = (holder.transferPickerCalls ?? 0) + 1;
            throw new Error("package picker must not open for a non-empty library");
          },
        });
      });

      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "设置" });
      await settings.getByRole("button", { name: "数据迁移" }).click();
      await settings.getByRole("button", { name: "导入完整数据包" }).click();
      const wizard = page.getByRole("dialog", { name: "完整数据迁移" });
      await wizard.getByRole("button", { name: "导入完整数据包" }).click();
      await expect(wizard.getByRole("heading", { name: "当前专利库不是空库" })).toBeVisible();
      expect(
        await application.evaluate(
          () =>
            (globalThis as typeof globalThis & { transferPickerCalls?: number })
              .transferPickerCalls ?? 0,
        ),
      ).toBe(0);
    } finally {
      await application.close().catch(() => undefined);
    }
  });

  test("wrong password and authenticated-header damage share one public failure", async ({
    workbench,
  }) => {
    const fixture = await createV1MinimalPackageFixture();
    const packagePath = join(workbench.root, "虚构安全包.zxwbackup");
    const damagedPath = join(workbench.root, "虚构损坏头安全包.zxwbackup");
    await writeFile(packagePath, fixture.bytes);
    const damaged = Buffer.from(fixture.bytes);
    const mac = Buffer.from(fixture.publicHeader.headerMacHex, "utf8");
    const macOffset = damaged.indexOf(mac);
    expect(macOffset).toBeGreaterThanOrEqual(0);
    damaged.writeUInt8(damaged.readUInt8(macOffset) ^ 1, macOffset);
    await writeFile(damagedPath, damaged);

    const wrongPassword = await readerFailure(packagePath, "虚构错误口令用于安全门禁甲乙");
    const damagedHeader = await readerFailure(damagedPath);
    expect(wrongPassword?.code).toBe("PASSWORD_OR_PACKAGE_INVALID");
    expect(damagedHeader?.code).toBe("PASSWORD_OR_PACKAGE_INVALID");
    expect(wrongPassword?.message).toBe(damagedHeader?.message);
    expect(wrongPassword?.message).not.toContain("虚构错误口令");
  });

  test("rejects frame tampering, truncation, excessive KDF work and source replacement", async ({
    workbench,
  }) => {
    const fixture = await createV1MinimalPackageFixture();
    const tamperedPath = join(workbench.root, "虚构帧损坏.zxwbackup");
    const truncatedPath = join(workbench.root, "虚构截断.zxwbackup");
    const excessiveKdfPath = join(workbench.root, "虚构过量KDF.zxwbackup");
    const replacedPath = join(workbench.root, "虚构源替换.zxwbackup");
    const targetFrame = fixture.frames.find((frame) => frame.role === "stored");
    if (!targetFrame) throw new Error("fixture has no stored frame");
    const tampered = Buffer.from(fixture.bytes);
    tampered.writeUInt8(tampered.readUInt8(targetFrame.cipherOffset) ^ 1, targetFrame.cipherOffset);
    expect(tampered.equals(fixture.bytes)).toBe(false);
    await Promise.all([
      writeFile(tamperedPath, tampered),
      writeFile(truncatedPath, fixture.bytes.subarray(0, fixture.bytes.byteLength - 1)),
      writeFile(excessiveKdfPath, mutateHeaderNumber(fixture.bytes, '"N":131072', '"N":262144')),
      writeFile(replacedPath, fixture.bytes),
    ]);

    expect((await readerFailure(tamperedPath))?.code).toBe("PACKAGE_TAMPERED");
    expect((await readerFailure(truncatedPath))?.code).toBe("PACKAGE_INCOMPLETE");
    expect((await readerFailure(excessiveKdfPath))?.code).toBe("PACKAGE_TAMPERED");

    const reader = await PackageReader.open(replacedPath);
    try {
      await reader.readPublicHeader();
      const replaced = Buffer.from(fixture.bytes);
      replaced.writeUInt8(replaced.readUInt8(replaced.byteLength - 1) ^ 1, replaced.byteLength - 1);
      await writeFile(replacedPath, replaced);
      await expect(reader.unlock(V1_FIXTURE_PASSWORD)).rejects.toMatchObject({
        code: "PACKAGE_INCOMPLETE",
      });
    } finally {
      await reader.close().catch(() => undefined);
    }
  });

  test("rejects path escape, reparse targets and compression bombs before extraction", () => {
    expect(() => new ArchivePathPolicy().claim("../outside", 1, 1)).toThrow(
      expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
    );
    expect(() => assertSafeExtractionTargetMetadata({ classification: "reparse-point" })).toThrow(
      expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
    );
    expect(() => new ArchivePathPolicy().claim("portable-settings.json", 1, 201)).toThrow(
      expect.objectContaining({ code: "PACKAGE_TAMPERED" }),
    );
  });

  test("never overwrites an existing destination or exposes password and full path", async ({
    workbench,
  }) => {
    const existingPath = join(workbench.root, "虚构既有目标.zxwbackup");
    const originalBytes = Buffer.from("caller-owned-existing-target", "utf8");
    await writeFile(existingPath, originalBytes);
    const application = await workbench.launch();
    try {
      await application.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, "showSaveDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePath: path }),
        });
      }, existingPath);
      const page = await application.firstWindow();
      const password = "虚构既有目标保护口令甲乙丙丁";
      const result = await page.evaluate(
        async ({ operationId, migrationPassword }) => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          const selected = await api.dataTransfer.selectExportDestination();
          if (!selected.ok || !selected.value) throw new Error("destination selection failed");
          return await api.dataTransfer.exportPackage({
            operationId,
            destinationSelectionId: selected.value.selectionId,
            password: migrationPassword,
            passwordHint: null,
            passwordRecorded: true,
          });
        },
        { operationId: randomUUID(), migrationPassword: password },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_OVERWRITE" } });
      expect(await readFile(existingPath)).toEqual(originalBytes);
      const publicFailure = JSON.stringify(result);
      expect(publicFailure).not.toContain(password);
      expect(publicFailure).not.toContain(existingPath);
    } finally {
      await application.close().catch(() => undefined);
    }
  });

  test("cancelled transfer settles within a bounded time and releases the operation gate", async ({
    workbench,
  }) => {
    test.setTimeout(60_000);
    const packagePath = join(workbench.root, "虚构取消安全包.zxwbackup");
    await writeFile(packagePath, (await createV1MinimalPackageFixture()).bytes);
    const profile = await workbench.launchProfile("cancel-security");
    try {
      await workbench.removeTransientProfileMarkers(profile);
      await profile.application.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        });
      }, packagePath);
      const page = await profile.application.firstWindow();
      const result = await page.evaluate(
        async ({ operationId, password }) => {
          const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
          const selected = await api.dataTransfer.selectImportPackage();
          if (!selected.ok || !selected.value) throw new Error("source selection failed");
          const preparation = api.dataTransfer.prepareImport({
            operationId,
            sourceSelectionId: selected.value.selectionId,
            password,
          });
          const cancellation = api.dataTransfer.cancel(operationId);
          const terminal = await Promise.race([
            preparation,
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("transfer cancellation hung")), 10_000),
            ),
          ]);
          return {
            cancellation: await cancellation,
            terminal,
            inspection: await api.dataTransfer.inspectLibrary(),
          };
        },
        { operationId: randomUUID(), password: V1_FIXTURE_PASSWORD },
      );
      expect(result.cancellation.ok).toBe(true);
      expect(result.terminal).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
      expect(result.inspection.ok).toBe(true);
    } finally {
      await profile.application.close().catch(() => undefined);
    }
  });
});

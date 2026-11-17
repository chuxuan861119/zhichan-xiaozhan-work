import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { APPLICATION_DATA_DIRECTORY } from "../../src/shared/branding.js";
import { expect, test } from "./helpers/workbench.js";

test("export interruption must not permanently block empty target import after restart", async ({
  workbench,
}) => {
  const source = await workbench.launchProfile("audit-export-interruption");
  const page = await source.application.firstWindow();
  const packagePath = join(workbench.root, "interrupted-export.zxwbackup");
  const applicationDataRoot = join(source.localAppData, APPLICATION_DATA_DIRECTORY);
  await source.application.evaluate(({ app, dialog, BrowserWindow }, destination) => {
    Object.defineProperty(dialog, "showSaveDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePath: destination }),
    });
    for (const window of BrowserWindow.getAllWindows()) {
      const original = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...arguments_) => {
        const progress = arguments_[0] as { phase?: string } | undefined;
        if (channel === "data-transfer:progress" && progress?.phase === "verifying-package") {
          app.exit(1); // Fault injection: only this test's synthetic hidden profile.
          return;
        }
        original(channel, ...arguments_);
      };
    }
  }, packagePath);
  const closed = new Promise<void>((resolve) => source.application.once("close", resolve));
  await page
    .evaluate(async () => {
      const selected = await window.patentApi.dataTransfer.selectExportDestination();
      if (!selected.ok || !selected.value) throw new Error("export destination selection failed");
      return window.patentApi.dataTransfer.exportPackage({
        operationId: "ef123456-1234-4567-8abc-123456789012",
        destinationSelectionId: selected.value.selectionId,
        password: "synthetic-migration-password-20261009",
        passwordHint: null,
        passwordRecorded: true,
      });
    })
    .catch((error) => {
      if (!page.isClosed()) throw error;
    });
  await closed;
  const before = (await readdir(applicationDataRoot)).filter((name) =>
    name.startsWith(".full-data-export-"),
  );
  expect(before).toHaveLength(1);
  const restarted = await workbench.relaunchProfile(source);
  try {
    await workbench.removeTransientProfileMarkers(restarted);
    const nextPage = await restarted.application.firstWindow();
    const inspection = await nextPage.evaluate(() =>
      window.patentApi.dataTransfer.inspectLibrary(),
    );
    const after = (await readdir(applicationDataRoot)).filter((name) =>
      name.startsWith(".full-data-export-"),
    );
    const exportFiles = await readdir(workbench.root);
    const temporaryFiles = await Promise.all(
      exportFiles
        .filter((name) => name.includes("interrupted-export"))
        .map(async (name) => ({ name, bytes: (await lstat(join(workbench.root, name))).size })),
    );
    expect(inspection).toMatchObject({ ok: true, value: { empty: true, blockers: [] } });
    expect(after).toEqual([]);
    expect(temporaryFiles).toEqual([]);
  } finally {
    await restarted.application.close().catch(() => undefined);
  }
});

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ImportStagingOwnership } from "../../src/main/data-transfer/import-staging-ownership.js";
import { APPLICATION_DATA_DIRECTORY } from "../../src/shared/branding.js";
import { expect, test } from "./helpers/workbench.js";

test("corrupt recovery journal must retain protection and staging across three restarts", async ({
  workbench,
}) => {
  const profile = await workbench.launchProfile("audit-corrupt-two-startups");
  await profile.application.close();
  const applicationDataRoot = join(profile.localAppData, APPLICATION_DATA_DIRECTORY);
  const operationId = "cd123456-1234-4567-8abc-123456789012";
  const roots = [
    join(dirname(profile.libraryRoot), `.import-staging-${operationId}`),
    join(dirname(profile.userData), `.import-user-data-${operationId}`),
  ];
  const ownership = new ImportStagingOwnership({
    applicationDataRoot,
    libraryRoot: profile.libraryRoot,
    userDataRoot: profile.userData,
  });
  await ownership.begin(operationId);
  for (const root of roots) {
    await mkdir(root);
    const value = await lstat(root, { bigint: true });
    await ownership.register(root, {
      device: String(value.dev),
      inode: String(value.ino),
      birthtimeNs: String(value.birthtimeNs),
    });
    await writeFile(join(root, "candidate.txt"), "synthetic migration candidate");
  }
  await writeFile(
    join(applicationDataRoot, "pending-data-import.json"),
    "{damaged-recovery-record",
  );
  const first = await workbench.relaunchProfile(profile);
  const page1 = await first.application.firstWindow();
  const report1 = await page1.evaluate(async () => {
    const read = window.patentApi.application.getStartupRecoveryReport;
    if (!read) throw new Error("Missing startup recovery report");
    return await read();
  });
  expect(report1).toMatchObject({
    ok: true,
    value: { mode: "read-only", dataImportRecovery: "manual-safe-recovery" },
  });
  await expect(page1.getByRole("alert", { name: "完整数据迁移需要人工恢复" })).toBeVisible();
  for (const root of roots)
    expect(await readFile(join(root, "candidate.txt"), "utf8")).toBe(
      "synthetic migration candidate",
    );
  await first.application.close();
  let previous = first;
  for (let restart = 2; restart <= 3; restart++) {
    const second = await workbench.relaunchProfile(previous);
    try {
      const page2 = await second.application.firstWindow();
      const report2 = await page2.evaluate(async () => {
        const read = window.patentApi.application.getStartupRecoveryReport;
        if (!read) throw new Error("Missing startup recovery report");
        return await read();
      });
      const preserved = await Promise.all(
        roots.map(
          async (root) =>
            await lstat(root).then(
              () => true,
              () => false,
            ),
        ),
      );

      expect(report2).toMatchObject({
        ok: true,
        value: { mode: "read-only", dataImportRecovery: "manual-safe-recovery" },
      });
      expect(preserved).toEqual([true, true]);
      await expect(page2.getByRole("alert", { name: "完整数据迁移需要人工恢复" })).toBeVisible();
    } finally {
      await second.application.close();
    }
    previous = second;
  }
});

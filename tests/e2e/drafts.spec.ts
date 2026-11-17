import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PatentApi } from "../../src/shared/ipc/contract.js";
import { expect, test, type WorkbenchHarness } from "./helpers/workbench.js";

type WorkbenchApplication = {
  windows(): Page[];
  close(): Promise<void>;
};

async function dismissWelcome(page: Page): Promise<void> {
  await page.getByTestId("app-shell").waitFor({ state: "visible" });
  const welcome = page.getByRole("dialog", { name: "欢迎使用知产小栈专利工作台" });
  const visible = await welcome
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (visible) await welcome.getByRole("button", { name: "暂不创建" }).click();
}

async function closeWorkbench(application: WorkbenchApplication): Promise<void> {
  const page = application.windows().find((item) => !item.isClosed());
  if (page) {
    await page
      .evaluate(() =>
        (
          globalThis as unknown as {
            patentApi: { application: { forceClose(): Promise<void> } };
          }
        ).patentApi.application.forceClose(),
      )
      .catch(() => undefined);
  }
  await application.close().catch(() => undefined);
}

async function createLegacyDraftViaApp(workbench: WorkbenchHarness): Promise<string> {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    const draftId = await page.evaluate(async () => {
      const api = (globalThis as unknown as { patentApi: PatentApi }).patentApi;
      const created = await api.library.create();
      if (!created.ok) throw new Error(`library.create failed: ${created.error.code}`);
      const document = { ...created.value.document, title: "旧草稿" };
      const saved = await api.drafts.save({
        sessionId: created.value.sessionId,
        documentId: document.documentId,
        document,
        editorState: created.value.editorState,
        originalPath: "D:\\案件\\旧草稿.patdoc",
        displayName: "旧草稿.patdoc",
      });
      if (!saved.ok) throw new Error(`drafts.save failed: ${saved.error.code}`);
      const released = await api.library.release(created.value.sessionId);
      if (!released.ok) throw new Error(`library.release failed: ${released.error.code}`);
      return saved.value.draftId;
    });
    return draftId;
  } finally {
    await closeWorkbench(application);
  }
}

test("does not expose the obsolete manual draft controls", async ({ workbench }) => {
  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByRole("dialog", { name: "自动保存草稿" })).toHaveCount(0);

    await page.getByRole("button", { name: "文件" }).click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "打开自动保存草稿" })).toHaveCount(0);
    await expect(page.getByText("自动保存", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "文件" }).click();
  } finally {
    await closeWorkbench(application);
  }
});

test.skip("copies legacy drafts into the internal library while keeping the source draft", async ({
  workbench,
}) => {
  const draftId = await createLegacyDraftViaApp(workbench);
  const draftMetadataPath = join(workbench.userData, "drafts", draftId, "draft.json");

  const application = await workbench.launch();
  try {
    const page = await application.firstWindow();
    await dismissWelcome(page);
    await expect(page.getByRole("dialog", { name: "旧草稿迁移" })).toBeVisible();
    await expect(page.getByText("旧草稿.patdoc")).toBeVisible();

    await page.getByRole("button", { name: "导入选中的旧草稿" }).click();

    await expect(page.getByRole("textbox", { name: "编辑 旧草稿" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /旧草稿/u })).toBeVisible();
    await expect.poll(() => stat(draftMetadataPath).then(() => true)).toBe(true);
  } finally {
    await closeWorkbench(application);
  }
});

import { join } from "node:path";
import { FileService } from "../../src/main/documents/file-service.js";
import { createBlankDocument } from "../../src/shared/document/defaults.js";
import { expect, test } from "./helpers/workbench.js";

async function writePatdoc(path: string, title: string): Promise<void> {
  const result = await new FileService().saveDocument(path, {
    document: createBlankDocument(title),
    settings: {},
    editorState: {},
    assets: [],
  });
  expect(result.ok).toBe(true);
}

test.skip("opens first and second instance patdoc paths once and rejects other arguments", async ({
  workbench,
}) => {
  const firstPath = join(workbench.root, "首实例.patdoc");
  const secondPath = join(workbench.root, "二实例.patdoc");
  await writePatdoc(firstPath, "首实例文档");
  await writePatdoc(secondPath, "二实例文档");
  const application = await workbench.launch(firstPath);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("tab", { name: "首实例文档" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);

    await workbench.launchSecondInstance(firstPath);
    await expect(page.getByRole("tab")).toHaveCount(2);

    await workbench.launchSecondInstance(join(workbench.root, "拒绝.txt"));
    await expect(page.getByRole("tab")).toHaveCount(2);

    await workbench.launchSecondInstance(secondPath);
    await expect(page.getByRole("tab", { name: "二实例文档" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(3);
    await expect(page.getByTestId("app-shell")).toBeVisible();
  } finally {
    await application.close().catch(() => undefined);
  }
});

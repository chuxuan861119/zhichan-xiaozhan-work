import { expect, test } from "./helpers/workbench.js";

test("IPC validates input, recovers failed queries and restores within a smaller host", async ({
  workbench,
}) => {
  test.setTimeout(90000);
  const app = await workbench.launch();
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const welcome = page.getByRole("button", { name: "暂不创建", exact: true });
    if (await welcome.isVisible()) await welcome.click();
    await page.getByRole("button", { name: "IPC数据中心", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "IPC数据中心", exact: true });
    const iframe = page.frameLocator('iframe[title="IPC数据中心查询页面"]');
    await expect(iframe.locator("#classificationInput")).toBeEnabled({ timeout: 35000 });
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect(iframe.locator("body > header")).toHaveCount(0);
    await expect(iframe.locator("#topControlPanel")).toHaveCSS("top", "0px");
    await dialog.getByRole("button", { name: "使用说明", exact: true }).click();
    await expect(iframe.locator("#helpModal")).toBeVisible();
    await dialog.getByRole("button", { name: "使用说明", exact: true }).click();
    await expect(iframe.locator("#helpModal")).toBeVisible();
    await iframe.locator("body").press("Escape");
    await expect(iframe.locator("#helpModal")).toBeHidden();
    const frame = page.frames().find((frame) => frame.url().startsWith("patent-ipc://center"));
    if (!frame) throw new Error("IPC frame missing");
    await iframe.locator("#classificationInput").fill("A");
    await iframe.locator("#preExamBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#preExamRestrictionModal")).toBeVisible();
    await iframe.locator("body").press("Escape");
    await iframe.locator("#classificationInput").fill("a01b　1/02");
    await iframe.locator("#queryIPCBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("锹；铲");
    await iframe.locator("#preExamBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("已自动切换至上级小类");
    // A new result view must not leave an export action for the previous query.
    await frame.evaluate(`(() => {
      const original = requestQuery;
      requestQuery = (...args) => new Promise(resolve => {
        window.finishDelayedQuery = async () => { resolve(await original(...args)); };
      });
      window.restoreRequestQuery = () => { requestQuery = original; };
      queryIPC('手动工具');
    })()`);
    await expect(iframe.locator("#shareReportBtn")).toBeHidden();
    expect(await frame.evaluate("window.currentPreExamData")).toBeNull();
    await frame.evaluate("window.finishDelayedQuery()");
    await frame.evaluate("window.restoreRequestQuery()");
    await iframe.locator("#priorityBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("智能制造装备产业");
    await iframe.locator("#classificationInput").fill("A01B99999/99");
    await iframe.locator("#preExamBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("未收录");
    await expect(iframe.locator("#shareReportBtn")).toBeHidden();
    expect(await frame.evaluate("window.currentPreExamData")).toBeNull();
    await iframe
      .getByRole("button", { name: "按 A01B 查询" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#preExamResultContainer")).toContainText("A01B");
    expect(await frame.evaluate("window.currentPreExamData.originalCode")).toBeNull();

    // Accelerate only the query timeout while simulating a worker that drops one request.
    await frame.evaluate(`(() => {
      const post = queryWorker.postMessage.bind(queryWorker);
      const timer = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => timer(fn, ms === 30000 ? 10 : ms, ...args);
      queryWorker.postMessage = () => { queryWorker.postMessage = post; };
      window.restoreAuditTimer = () => { window.setTimeout = timer; };
    })()`);
    await iframe.locator("#classificationInput").fill("人工智能");
    await iframe.locator("#priorityBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("查询未完成");
    await frame.evaluate("window.restoreAuditTimer()");
    await iframe
      .getByRole("button", { name: "重试查询", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("匹配统计");

    const native = await app.browserWindow(page);
    await native.evaluate((win) => win.setContentSize(1440, 900));
    const header = dialog.locator("header");
    const before = await header.boundingBox();
    if (!before) throw new Error("Header missing");
    await page.mouse.move(before.x + 100, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(1300, 200, { steps: 5 });
    await page.mouse.up();
    await dialog.getByRole("button", { name: "最大化IPC数据中心" }).click();
    await native.evaluate((win) => win.setContentSize(1024, 700));
    await dialog.getByRole("button", { name: "还原IPC数据中心" }).click();
    await expect
      .poll(async () => {
        const bounds = await dialog.boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        return (
          !!bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= viewport.width + 1 &&
          bounds.y + bounds.height <= viewport.height + 1
        );
      })
      .toBe(true);
    await frame.evaluate("showProtectionCenterContent('上海', '上海保护中心')");
    await frame.evaluate("window.scrollTo(0, 800)");
    await expect
      .poll(() =>
        frame.evaluate(`(() => {
      const info = document.getElementById('protectionCenterInfo').getBoundingClientRect();
      const controls = document.getElementById('topControlPanel').getBoundingClientRect();
      return Math.abs(info.top - controls.bottom) < 1;
    })()`),
      )
      .toBe(true);
    await iframe.locator("#locarnoButton").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#classificationTypeText")).toContainText("洛迦诺");
    await iframe.locator("#dictionaryBtn").evaluate((button: HTMLButtonElement) => button.click());
    await frame.evaluate(`(() => {
      for (const id of ['section-A-content', 'class-A01-content', 'subclass-A01B-content', 'maingroup-A01B1/00-content']) {
        document.getElementById(id).previousElementSibling.click();
      }
      window.scrollTo(0, 650);
    })()`);
    const checkAncestors = () =>
      frame.evaluate(`(() => {
      const headers = [...document.querySelectorAll('#dictionaryContent .dictionary-parent')];
      let top = document.getElementById('topControlPanel').getBoundingClientRect().bottom;
      return headers.length === 4 && headers.every(header => {
        const rect = header.getBoundingClientRect();
        const matches = Math.abs(rect.top - top) < 1;
        top = rect.bottom;
        return matches;
      });
    })()`);
    await expect.poll(checkAncestors).toBe(true);
    await native.evaluate((win) => win.setContentSize(1180, 900));
    await expect.poll(checkAncestors).toBe(true);
    await dialog.evaluate((el) => {
      el.style.width = "480px";
      el.style.height = "360px";
    });
    await expect.poll(() => frame.evaluate("innerHeight")).toBeLessThan(330);
    await expect.poll(checkAncestors).toBe(true);
    expect(
      await frame.evaluate(`(() => {
      const last = document.getElementById('maingroup-A01B1/00-content').previousElementSibling.getBoundingClientRect();
      return document.getElementById('ipcBottomToolbar').getBoundingClientRect().top - last.bottom;
    })()`),
    ).toBeGreaterThan(40);
    await dialog.evaluate((el) => {
      el.style.width = "860px";
      el.style.height = "600px";
    });
    await frame.evaluate(
      "document.getElementById('maingroup-A01B1/00-content').previousElementSibling.click()",
    );
    await expect(iframe.locator("#dictionaryContent .dictionary-parent")).toHaveCount(3);
    await frame.evaluate(`(() => {
      const original = requestQuery;
      requestQuery = (...args) => new Promise(resolve => {
        window.finishDelayedQuery = async () => { resolve(await original(...args)); };
      });
      window.restoreRequestQuery = () => { requestQuery = original; };
      document.getElementById('classificationInput').value = 'A01B';
      document.getElementById('priorityBtn').click();
    })()`);
    await iframe.locator("#classificationInput").fill("B01D");
    await expect(iframe.locator("#contentArea")).toContainText("输入已更改，请重新查询");
    await frame.evaluate("window.finishDelayedQuery()");
    await frame.evaluate("window.restoreRequestQuery()");
    await expect(iframe.locator("#contentArea")).toContainText("输入已更改，请重新查询");
    await iframe.locator("#priorityBtn").evaluate((button: HTMLButtonElement) => button.click());
    await expect(iframe.locator("#contentArea")).toContainText("匹配统计");
    await frame.evaluate(`(() => {
      const original = requestQuery;
      requestQuery = (...args) => new Promise(resolve => {
        window.finishDelayedQuery = async () => { resolve(await original(...args)); };
      });
      window.restoreRequestQuery = () => { requestQuery = original; };
      document.getElementById('priorityBtn').click();
      document.getElementById('protectionBtn').click();
      closeProtectionCenterModal();
    })()`);
    await frame.evaluate("window.finishDelayedQuery()");
    await frame.evaluate("window.restoreRequestQuery()");
    await expect(iframe.locator("#contentArea")).toContainText("匹配统计");
    await expect(iframe.locator("#exactMatchBtn")).toBeVisible();
    await frame.evaluate(`(() => {
      const original = requestQuery;
      requestQuery = (...args) => new Promise(resolve => {
        window.finishDelayedQuery = async () => { resolve(await original(...args)); };
      });
      window.restoreRequestQuery = () => { requestQuery = original; };
      document.getElementById('priorityBtn').click();
      showProtectionCenterContent('上海', '上海保护中心');
    })()`);
    await frame.evaluate("window.finishDelayedQuery()");
    await frame.evaluate("window.restoreRequestQuery()");
    await expect(iframe.locator("#protectionCenterInfo")).toContainText("上海保护中心");
    await frame.evaluate("queryPreExam('机械')");
    await expect(iframe.locator("#contentArea")).toContainText("关键词：机械");
    await frame.evaluate("window.scrollTo(0, 700)");
    await expect
      .poll(() =>
        frame.evaluate(`(() => {
      const info = document.querySelector('#contentArea .sticky').getBoundingClientRect();
      return Math.abs(info.top - document.getElementById('topControlPanel').getBoundingClientRect().bottom);
    })()`),
      )
      .toBeLessThan(1);
    await frame.evaluate("showKeywordSearchModal('人工智能')");
    await expect(iframe.locator("#keywordSearchContent")).not.toHaveText("查询中…");
    await iframe.locator("#keywordSearchModal button").first().focus();
    await frame.evaluate("openIpcDetailModal('A01B')");
    await iframe.locator("#ipcDetailModal").press("Escape");
    await expect(iframe.locator("#ipcDetailModal")).toBeHidden();
    await expect(iframe.locator("#keywordSearchModal")).toBeVisible();
    await expect(iframe.locator("#keywordSearchModal button").first()).toBeFocused();
    expect(await frame.evaluate("document.body.style.overflow")).toBe("hidden");
    await frame.evaluate("toggleHelpModal()");
    await iframe.locator("#helpModal").press("Escape");
    await expect(iframe.locator("#helpModal")).toBeHidden();
    await expect(iframe.locator("#keywordSearchModal")).toBeVisible();
    expect(await frame.evaluate("document.body.style.overflow")).toBe("hidden");
    await iframe.locator("#keywordSearchModal").press("Escape");
    await expect(iframe.locator("#keywordSearchModal")).toBeHidden();
    expect(await frame.evaluate("document.body.style.overflow")).toBe("");
    await frame.evaluate("openProtectionCenterModal(); openRegionSettingsModal()");
    await iframe.locator("#regionSettingsModal").press("Escape");
    await expect(iframe.locator("#regionSettingsModal")).toBeHidden();
    await expect(iframe.locator("#protectionCenterModal")).toBeVisible();
    expect(await frame.evaluate("document.body.style.overflow")).toBe("hidden");
    await frame.evaluate("showImagePreview(document.createElement('canvas').toDataURL())");
    await iframe.locator("#imagePreviewModal").press("Escape");
    await expect(iframe.locator("#imagePreviewModal")).toHaveCount(0);
    expect(await frame.evaluate("document.body.style.overflow")).toBe("hidden");
    await iframe.locator("#protectionCenterModal").press("Escape");
    expect(await frame.evaluate("document.body.style.overflow")).toBe("");
    await dialog.getByRole("button", { name: "返回编辑器" }).click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
    if (process.env.PATENT_WORKBENCH_E2E_BACKGROUND === "1")
      expect(await native.evaluate((win) => win.isVisible())).toBe(false);
  } finally {
    await app.close();
  }
});

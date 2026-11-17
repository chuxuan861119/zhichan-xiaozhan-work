import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

for (const stage of [
  "acknowledged checkpoint",
  "unfinished save",
  "interrupted stroke and immediate retry",
  "edited checkpoint and interrupted retry",
])
  test(`Fast Refresh preserves native geometry with ${stage}`, async () => {
    const pendingSave = stage === "unfinished save",
      edited = stage.startsWith("edited"),
      retry = edited || stage.startsWith("interrupted");
    const url = process.env.PATENT_WORKBENCH_CAD_HMR_URL;
    test.skip(
      !url,
      "Requires an explicit development-server URL; never navigates the user instance",
    );
    const browser = await chromium.launch({
      headless: true,
      ...(process.platform === "win32" ? { channel: "chrome" } : {}),
    });
    try {
      const page = await browser.newPage();
      page.on("pageerror", (error) => console.error("CAD refresh fixture:", error.message));
      // Re-evaluate the transformed module with the same Refresh registration ID,
      // without modifying files or broadcasting a hot update to the user's page.
      await page.route("**/cad-editing-panel.tsx?refresh-probe=*", async (route) => {
        const response = await route.fetch({
          url: new URL("src/drawing-markup/cad-editing-panel.tsx", url).href,
        });
        await route.fulfill({ response, body: await response.text() });
      });
      const fixture = resolve("src/shared/drawing-markup/test-fixture.ts").replaceAll("\\", "/");
      await page.route("**/cad-refresh-probe.html", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: String.raw`
      <meta charset="utf-8"><div id="root"></div><script type="module">
      import * as RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const panelUrl = '/src/drawing-markup/cad-editing-panel.tsx';
      const code = await fetch(panelUrl).then(r => r.text());
      const reactUrl = code.match(/import __vite__cjsImport\d+_react from "([^"]+)"/)[1];
      const main = await fetch('/src/main.tsx').then(r => r.text());
      const domUrl = main.match(/from "([^"]*react-dom_client[^\"]+)"/)[1];
      const ReactModule = await import(reactUrl), React = ReactModule.default;
      const DomModule = await import(domUrl);
      const { CadEditingPanel } = await import(panelUrl);
      const { CadcraftClient } = await import('/src/drawing-markup/cadcraft-client.ts');
      const { drawingProjectFixture } = await import('/@fs/${fixture}');
      const project = drawingProjectFixture('00000000-0000-4000-8000-000000000001');
      project.cad = { version: 1, engine: 'cadcraft', engineVersion: 'a'.repeat(40), assetId: project.sourceAssetId, unified: 1, mapping: { originX: 0, originY: 100, scale: 1 } };
      const seed = new CadcraftClient();
      const initial = await seed.request('execute', 'circle', { center: [0,0], radius: 5 });
      seed.close();
      const probe = window.cadProbe = { saved: initial.bytes, scene: initial.scene, ref: React.createRef(), reads: 0, resets: 0, executions: 0, hold: false };
      const originalPost = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...rest) {
        if(probe.blockExecute && (message.method === 'execute' || message.method === 'edit')) { probe.blocked = true; return; }
        if(probe.blockLoad && message.method === 'load') { probe.releaseLoad = () => Reflect.apply(originalPost, this, [message, ...rest]); return; }
        return Reflect.apply(originalPost, this, [message, ...rest]);
      };
      window.patentApi = { assets: { readDrawingSource: async () => { probe.reads++; return { ok: true, value: probe.saved }; } } };
      const props = { ref: probe.ref, project, sessionId: 'probe', enabled: true, disabled: false,
        onEnabled() {}, onSelection(value) { if(value) probe.scene = value.scene; else probe.resets++; }, onPreview() {}, onBusy() {}, onError(message) { probe.error = message; }, onPendingDrawing() { probe.executions++; },
        onCommit: async (bytes, prepared) => { if(probe.hold) await new Promise(resolve => { probe.release = resolve; }); probe.saved = bytes; prepared(project.cad.assetId); return { bytes, objects: [], scene: probe.scene }; } };
      (DomModule.createRoot ?? DomModule.default.createRoot)(document.getElementById('root')).render(React.createElement(CadEditingPanel, props));
      probe.draw = async (offset) => { probe.ref.current.pointDown({x:200+offset,y:200}, 1, false); probe.ref.current.click({x:300+offset,y:220}, false, 1); return probe.ref.current.flush(); };
      probe.aids = () => {
        const el = document.querySelector('[aria-label="CAD实体编辑"]');
        let fiber = el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
        while(fiber && fiber.type?.name !== 'CadEditingPanel') fiber = fiber.return;
        for(let hook = fiber?.memoizedState; hook; hook = hook.next)
          if(hook.memoizedState?.current?.constructor?.name === 'CadDraftingAids') return hook.memoizedState.current;
        throw new Error('CAD aids missing');
      };
      probe.refresh = async () => {
        const filename = code.match(/registerExportsForReactRefresh\("([^"]+)"/)[1];
        const fresh = await import(panelUrl + '?refresh-probe=' + Date.now());
        return RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(filename, { CadEditingPanel }, { CadEditingPanel: fresh.CadEditingPanel }) ?? null;
      };
      </script>`,
        }),
      );
      await page.goto(new URL("cad-refresh-probe.html", url).href);
      const line = page.getByRole("button", { name: "直线", exact: true });
      await expect(line).toBeEnabled();
      await line.click();
      expect(await page.evaluate("window.cadProbe.draw(0)")).toBe(true);
      expect(await page.evaluate("window.cadProbe.scene.entityCount")).toBe(2);
      if (edited) {
        await page.evaluate(`const p = window.cadProbe;
          p.ref.current.selectHandles([p.scene.entities.find(e => e.type === 'Circle').handle]);
          p.ref.current.erase();`);
        await expect.poll(() => page.evaluate("window.cadProbe.scene.entityCount")).toBe(1);
        await expect(line).toBeEnabled();
      }
      if (pendingSave) {
        await line.click();
        await page.evaluate(
          "window.cadProbe.hold = true; window.cadProbe.pendingDraw = window.cadProbe.draw(200); void 0",
        );
        await page.waitForFunction("typeof window.cadProbe.release === 'function'");
        expect(await page.evaluate("window.cadProbe.scene.entityCount")).toBe(3);
      }
      if (retry) {
        await line.click();
        await page.evaluate(
          "window.cadProbe.blockExecute = true; window.cadProbe.oldDraw = window.cadProbe.draw(200); void 0",
        );
        await page.waitForFunction("window.cadProbe.blocked === true");
        await page.evaluate(
          "window.cadProbe.blockExecute = false; window.cadProbe.blockLoad = true; void 0",
        );
      }
      await page.evaluate("window.cadProbe.oldAids = window.cadProbe.aids(); void 0");
      expect(await page.evaluate("window.cadProbe.refresh()")).toBeNull();
      await page.waitForFunction("window.cadProbe.resets > 0");
      if (retry) {
        await page.waitForFunction("typeof window.cadProbe.releaseLoad === 'function'");
        expect(await page.evaluate("window.cadProbe.oldDraw")).toBe(false);
        await page.evaluate(
          "window.cadProbe.error = null; window.cadProbe.retried = window.cadProbe.ref.current.flush(); void 0",
        );
        await page.evaluate(
          "window.cadProbe.blockLoad = false; window.cadProbe.releaseLoad(); void 0",
        );
        expect(await page.evaluate("window.cadProbe.retried")).toBe(true);
      } else {
        await expect(line).toBeEnabled();
        await line.click();
      }
      if (pendingSave) {
        await page.evaluate("window.cadProbe.newDraw = window.cadProbe.draw(400); void 0");
        await page.waitForFunction("window.cadProbe.executions === 3");
        await page.evaluate("window.cadProbe.hold = false; window.cadProbe.release(); void 0");
        expect(await page.evaluate("window.cadProbe.newDraw")).toBe(true);
      } else if (!retry) expect(await page.evaluate("window.cadProbe.draw(200)")).toBe(true);
      expect(await page.evaluate("window.cadProbe.scene.entityCount")).toBe(
        edited ? 2 : pendingSave ? 4 : 3,
      );
      expect(await page.evaluate("window.cadProbe.error ?? null")).toBeNull();
      if (stage === "acknowledged checkpoint")
        expect(await page.evaluate("window.cadProbe.oldAids !== window.cadProbe.aids()")).toBe(
          true,
        );
    } finally {
      await browser.close();
    }
  });

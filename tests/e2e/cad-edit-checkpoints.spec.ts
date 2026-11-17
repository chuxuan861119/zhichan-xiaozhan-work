import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";

test("independent checkpoint worker preserves revisions, retry and later geometry", async () => {
  test.setTimeout(90_000);
  const compiled = await build({
    entryPoints: [resolve("src/renderer/src/drawing-markup/cadcraft-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "worker-assets",
        setup(b) {
          b.onLoad({ filter: /cadcraft-worker\.ts$/ }, async (a) => ({
            loader: "ts",
            contents: (await readFile(a.path, "utf8"))
              .replace(
                'new URL("../../../../resources/cadcraft/wasm/cadcraft_bg.wasm", import.meta.url)',
                'new URL("http://localhost/cadcraft.wasm")',
              )
              .replace(
                'new URL("../../../shared/document/fonts/SourceHanSerifCN-Regular.otf", import.meta.url)',
                'new URL("http://localhost/font.otf")',
              ),
          }));
        },
      },
    ],
  });
  const wasm = await readFile("resources/cadcraft/wasm/cadcraft_bg.wasm");
  const font = await readFile("src/shared/document/fonts/SourceHanSerifCN-Regular.otf");
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32"
      ? { channel: "msedge" }
      : process.platform === "darwin"
        ? { channel: "chrome" }
        : {}),
  });
  try {
    const context = await browser.newContext();
    await context.route("http://localhost/**", (route) => {
      const url = route.request().url();
      return route.fulfill({
        body: url.endsWith(".wasm")
          ? wasm
          : url.endsWith(".otf")
            ? font
            : url.endsWith(".js")
              ? compiled.outputFiles[0]!.text
              : "<body/>",
        contentType: url.endsWith(".wasm")
          ? "application/wasm"
          : url.endsWith(".js")
            ? "text/javascript"
            : url.endsWith(".otf")
              ? "font/otf"
              : "text/html",
      });
    });
    const page = await context.newPage();
    await page.goto("http://localhost/");
    const result = await page.evaluate(async () => {
      const make = () => {
        const worker = new Worker("http://localhost/worker.js", { type: "module" });
        let id = 0;
        const pending = new Map<
          number,
          { resolve: (v: any) => void; reject: (e: Error) => void }
        >();
        worker.onmessage = (e) => {
          const p = pending.get(e.data.id);
          pending.delete(e.data.id);
          if (e.data.ok) p?.resolve(e.data.value);
          else p?.reject(Error(e.data.error));
        };
        return {
          worker,
          request: (method: string, ...args: unknown[]) =>
            new Promise<any>((resolve, reject) => {
              pending.set(++id, { resolve, reject });
              worker.postMessage({ id, method, args });
            }),
        };
      };
      const editor = make(),
        saver = make(),
        reader = make();
      try {
        await editor.request(
          "load",
          new TextEncoder().encode("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"),
        );
        const first = await editor.request("edit", "line", {
          points: [
            [0, 0],
            [10, 0],
          ],
        });
        const handle = first.scene.entities[0].handle;
        const saving = saver.request("materialize", first.checkpoint);
        const second = await editor.request("edit", "move", { handles: [handle], delta: [3, 4] });
        const live = await editor.request("scene");
        const original = await reader.request("load", await saving);
        const secondBytes = await saver.request("materialize", second.checkpoint);
        const restored = await reader.request("load", secondBytes);
        const retried = await saver.request("materialize", second.checkpoint);
        const pasted = await editor.request(
          "editPaste",
          await saver.request("materialize", first.checkpoint),
          { handles: [handle], delta: [20, 0] },
        );
        const pastedLive = await editor.request("scene");
        const pastedReload = await reader.request(
          "load",
          await saver.request("materialize", pasted.checkpoint),
        );
        await editor.request("restore", secondBytes, "second");
        const reset = await editor.request("edit", "erase", { handles: [handle] });
        const erased = await reader.request(
          "load",
          await saver.request("materialize", reset.checkpoint),
        );
        const cached = await editor.request("checkout", "second");
        const cachedScene = await editor.request("scene");
        await reader.request("restore", second.checkpoint, "journal-restore");
        const journalScene = await reader.request("scene");
        await editor.request("remember", "accepted", cached.checkpoint);
        const remembered = await editor.request("checkout", "accepted");
        await editor.request("edit", "circle", {center:[30,30],radius:2});
        await editor.request("remember", "stale", cached.checkpoint);
        const stale = await editor.request("checkout", "stale");
        for (let i = 0; i < 9; i++) await editor.request("restore", secondBytes, `history-${i}`);
        const evicted = await editor.request("checkout", "second");
        const retained = await editor.request("checkout", "history-8");
        return {
          journalPoints: journalScene.primitives[0].points,
          remembered: remembered.restored,
          stale: stale.restored,
          partial: first.scene.partial,
          firstPoints: original.primitives[0].points,
          secondPoints: restored.primitives[0].points,
          matching: JSON.stringify(live.primitives) === JSON.stringify(restored.primitives),
          retried: Array.from(secondBytes).join() === Array.from(retried).join(),
          pasteMatching:
            JSON.stringify(pastedLive.primitives) === JSON.stringify(pastedReload.primitives),
          resetLength: reset.checkpoint.edits.length,
          erasedCount: erased.entities.length,
          cachedMatching:
            cached.restored &&
            JSON.stringify(cachedScene.primitives) === JSON.stringify(restored.primitives),
          evicted: evicted.restored,
          retained: retained.restored,
        };
      } finally {
        editor.worker.terminate();
        saver.worker.terminate();
        reader.worker.terminate();
      }
    });
    expect(result).toEqual({
      journalPoints: [[3, 4], [13, 4]],
      remembered: true,
      stale: false,
      partial: true,
      firstPoints: [
        [0, 0],
        [10, 0],
      ],
      secondPoints: [
        [3, 4],
        [13, 4],
      ],
      matching: true,
      retried: true,
      pasteMatching: true,
      resetLength: 1,
      erasedCount: 0,
      cachedMatching: true,
      evicted: false,
      retained: true,
    });
  } finally {
    await browser.close();
  }
});

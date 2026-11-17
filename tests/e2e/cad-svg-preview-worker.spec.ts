import { chromium, expect, test } from "@playwright/test";

test("CAD preview parses and renders in a worker without blocking the renderer", async () => {
  const origin = process.env.PATENT_WORKBENCH_CAD_HMR_URL;
  test.skip(!origin, "Requires an explicit development-server URL");
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.route("**/cad-svg-worker-probe.html", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<script type="module">
          import { CadSvgPreviewClient } from '/src/drawing-markup/cad-svg-preview-client.ts';
          const state = window.previewProbe = { posts: 0, mainParses: 0 };
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function(...args) {
            state.posts++;
            return Reflect.apply(post, this, args);
          };
          const parse = DOMParser.prototype.parseFromString;
          DOMParser.prototype.parseFromString = function(...args) {
            state.mainParses++;
            return Reflect.apply(parse, this, args);
          };
          const source = new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><style>.C1 {stroke: #000000; stroke-width: 2; stroke-opacity: 1; fill: none; fill-opacity: 1;}</style><path class="C1" d="M0 0L10 10"/><path class="C1" d="M20 20L30 30"/></svg>'
          );
          const client = new CadSvgPreviewClient();
          state.done = (async () => {
            state.prepared = await client.prepare(source, {width:100,height:80});
            const bytes = await client.render(source, {width:100,height:80}, {
              zoom: 1, scale: 1, width: 200, height: 160, offsetX: 0, offsetY: 0,
              visible: {x:0,y:0,width:100,height:80}
            }, true, 1, 1);
            state.blobResponse = bytes instanceof Blob;
            state.xml = bytes instanceof Blob ? await bytes.text() : new TextDecoder().decode(bytes);
            const image = new Image();
            const url = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], {type:'image/svg+xml'}));
            image.src = url;
            await image.decode();
            state.imageSize = [image.naturalWidth, image.naturalHeight];
            URL.revokeObjectURL(url);
            client.dispose();
          })();
        </script>`,
      }),
    );
    await page.goto(new URL("cad-svg-worker-probe.html", origin).href);
    const result = await page.evaluate(async () => {
      const probe = (
        window as unknown as Window & {
          previewProbe: {
            done: Promise<void>;
            posts: number;
            mainParses: number;
            prepared: { supportsScreenStrokes: boolean };
            imageSize: number[];
            xml: string;
            blobResponse: boolean;
          };
        }
      ).previewProbe;
      await probe.done;
      return {
        posts: probe.posts,
        mainParses: probe.mainParses,
        prepared: probe.prepared,
        imageSize: probe.imageSize,
        xml: probe.xml as string,
        blobResponse: probe.blobResponse,
      };
    });
    expect(result.posts).toBe(2);
    expect(result.blobResponse).toBe(true);
    expect(result.mainParses).toBe(0);
    expect(result.prepared).toEqual({ supportsScreenStrokes: true });
    expect(result.imageSize).toEqual([200, 160]);
    expect(result.xml.match(/<path /gu) ?? []).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

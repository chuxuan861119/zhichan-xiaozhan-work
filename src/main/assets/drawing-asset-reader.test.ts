// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AssetStore, type StoredAsset } from "./asset-store.js";
import { packDrawingTiles } from "./drawing-tiles.js";

test("dedicated tile reads reuse an immutable asset and release it on replacement and session close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tile-reader-"));
  try {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="0 0 1000000 800000"><path d="M0 0L1000000 800000" stroke="black"/></svg>',
    );
    const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").toUpperCase();
    const rect = { x: 0, y: 0, width: 1000, height: 800 };
    await writeFile(join(directory, "tile-0.svg"), svg);
    await writeFile(
      join(directory, "index.json"),
      JSON.stringify({
        version: 1,
        width: 1000,
        height: 800,
        tier: "large",
        primitives: 1,
        tiles: [
          { id: "tile-0", core: rect, render: rect, byteLength: svg.length, sha256: hash(svg) },
        ],
      }),
    );
    const packed = await packDrawingTiles(directory);
    const asset: StoredAsset = {
      descriptor: {
        assetId: randomUUID(),
        kind: "drawing-tiles",
        originalName: "drawing.cadtiles",
        mediaType: "application/vnd.zxw.cad-tiles+zip",
        extension: "cadtiles",
        widthPx: 1000,
        heightPx: 800,
        byteLength: packed.container.length,
        sha256: hash(packed.container),
        previewByteLength: packed.preview.length,
        previewSha256: hash(packed.preview),
      },
      original: packed.container,
      preview: packed.preview,
    };
    const readAsset = vi.fn(async () => asset);
    const store = new AssetStore({ persistent: { readAsset, install: vi.fn() } });
    store.createSession("session");
    expect(await store.readDrawingTile("session", asset.descriptor.assetId, "tile-0")).toEqual(svg);
    const mutated = await store.readDrawingTile("session", asset.descriptor.assetId, "tile-0");
    mutated[0] = 0;
    expect(await store.readDrawingTile("session", asset.descriptor.assetId, "tile-0")).toEqual(svg);
    expect(readAsset).toHaveBeenCalledOnce();
    store.put("session", { ...asset, original: new Uint8Array([0]) });
    await expect(
      store.readDrawingTile("session", asset.descriptor.assetId, "tile-0"),
    ).rejects.toMatchObject({ code: "CAD_TILES_INVALID" });
    store.put("session", asset);
    expect(
      (await store.readDrawingTileIndex("session", asset.descriptor.assetId)).tiles,
    ).toHaveLength(1);
    store.destroySession("session");
    await expect(
      store.readDrawingTile("session", asset.descriptor.assetId, "tile-0"),
    ).rejects.toThrow("资源会话不存在");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a session while its persistent asset loads cannot resurrect the cache", async () => {
  let finish!: (value: StoredAsset) => void;
  const readAsset = vi.fn(
    () =>
      new Promise<StoredAsset>((resolve) => {
        finish = resolve;
      }),
  );
  const store = new AssetStore({ persistent: { readAsset, install: vi.fn() } });
  store.createSession("closing");
  const pending = store.getOrLoad("closing", "asset");
  store.destroySession("closing");
  finish({
    descriptor: {} as StoredAsset["descriptor"],
    original: new Uint8Array(),
    preview: new Uint8Array(),
  });
  await expect(pending).rejects.toThrow("资源会话不存在");
  store.createSession("closing");
  expect(store.list("closing")).toEqual([]);
});

import type { AssetDescriptor } from "../../shared/document/model.js";
import type { ImportedAsset } from "../../shared/ipc/contract.js";
import { AssetStore, type StoredAsset } from "./asset-store.js";

type AssetStoreOptions = NonNullable<ConstructorParameters<typeof AssetStore>[0]>;
type PersistentFixture = NonNullable<AssetStoreOptions["persistent"]>;

const descriptor: AssetDescriptor = {
  assetId: "00000000-0000-4000-8000-000000000001",
  kind: "image",
  originalName: "drawing.png",
  mediaType: "image/png",
  extension: "png",
  byteLength: 3,
  sha256: "A".repeat(64),
  widthPx: 12,
  heightPx: 8,
  previewByteLength: 3,
  previewSha256: "B".repeat(64),
};

function storedAsset(): StoredAsset {
  return {
    descriptor: structuredClone(descriptor),
    original: new Uint8Array([1, 2, 3]),
    preview: new Uint8Array([4, 5, 6]),
  };
}

describe("asset store", () => {
  test("isolates assets by document session and returns defensive copies", () => {
    const store = new AssetStore();
    store.createSession("first");
    store.createSession("second");
    const input = storedAsset();
    store.put("first", input);
    input.original[0] = 99;

    const firstRead = store.get("first", descriptor.assetId);
    expect(firstRead?.original).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.get("second", descriptor.assetId)).toBeUndefined();

    if (firstRead) firstRead.preview[0] = 99;
    expect(store.get("first", descriptor.assetId)?.preview[0]).toBe(4);
  });

  test("supports listing, removing, and destroying a session", () => {
    const store = new AssetStore();
    store.createSession("session");
    store.put("session", storedAsset());

    expect(store.list("session")).toHaveLength(1);
    store.remove("session", descriptor.assetId);
    expect(store.list("session")).toEqual([]);
    store.put("session", storedAsset());
    store.destroySession("session");
    expect(() => store.list("session")).toThrow("资源会话不存在");
  });

  test("rejects writes to a session that was never created", () => {
    const store = new AssetStore();
    expect(() => store.put("missing", storedAsset())).toThrow("资源会话不存在");
  });

  test("persists imported assets before exposing them to a document session", async () => {
    const persisted = storedAsset();
    persisted.descriptor.assetId = "00000000-0000-4000-8000-000000000099";
    const persistent: PersistentFixture = {
      install: vi.fn(
        async (): Promise<ImportedAsset> => ({
          descriptor: persisted.descriptor,
          preview: new Uint8Array(persisted.preview),
        }),
      ),
      readAsset: vi.fn(async () => persisted),
    };
    const store = new AssetStore({ persistent });
    store.createSession("session", {
      kind: "library-document",
      libraryDocumentId: "library-document",
    });

    const result = await store.putPersistent("session", storedAsset());

    expect(persistent.install).toHaveBeenCalledWith(
      { kind: "library-document", libraryDocumentId: "library-document" },
      expect.any(Object),
    );
    expect(result.descriptor.assetId).toBe(persisted.descriptor.assetId);
    expect(store.get("session", persisted.descriptor.assetId)?.original).toEqual(
      persisted.original,
    );
  });

  test("forwards a custom template owner to persistent storage", async () => {
    const persistent: PersistentFixture = {
      install: vi.fn(
        async (_owner, asset): Promise<ImportedAsset> => ({
          descriptor: structuredClone(asset.descriptor),
          preview: Uint8Array.from(asset.preview),
        }),
      ),
      readAsset: vi.fn(async () => storedAsset()),
    };
    const store = new AssetStore({ persistent });
    const owner = {
      kind: "patent-template" as const,
      templateId: "00000000-0000-4000-8000-000000000123",
    };
    store.createSession("template-session", owner);

    await store.putPersistent("template-session", storedAsset());

    expect(persistent.install).toHaveBeenCalledWith(owner, expect.any(Object));
  });

  test("loads cache misses from persistent encrypted assets", async () => {
    const persisted = storedAsset();
    const persistent: PersistentFixture = {
      install: vi.fn(),
      readAsset: vi.fn(async () => persisted),
    };
    const store = new AssetStore({ persistent });
    store.createSession("session", {
      kind: "library-document",
      libraryDocumentId: "library-document",
    });

    expect(await store.getOrLoad("session", descriptor.assetId)).toEqual(persisted);
    expect(persistent.readAsset).toHaveBeenCalledWith(descriptor.assetId);
    expect(store.get("session", descriptor.assetId)).toEqual(persisted);
  });

  test("stages a validated image batch and commits its persistent leases together", async () => {
    const first = storedAsset();
    const second = storedAsset();
    second.descriptor.assetId = "00000000-0000-4000-8000-000000000002";
    second.descriptor.originalName = "second.png";
    const persistent: PersistentFixture = {
      install: vi.fn(),
      readAsset: vi.fn(),
      stageMany: vi.fn(async (_sessionId: string, assets: StoredAsset[]) =>
        assets.map((asset) => ({
          descriptor: structuredClone(asset.descriptor),
          preview: Uint8Array.from(asset.preview),
        })),
      ),
      commitStaged: vi.fn(async () => undefined),
      discardStaged: vi.fn(async () => undefined),
    };
    const store = new AssetStore({ persistent });
    store.createSession("session", { kind: "patent", patentId: "patent" });

    const imported = await store.putPersistentManyStaged("session", [first, second], "operation-1");
    await store.commitPersistentStages(
      "session",
      imported.map((asset) => asset.descriptor.assetId),
    );

    expect(persistent.stageMany).toHaveBeenCalledWith("session", [first, second], "operation-1");
    expect(persistent.commitStaged).toHaveBeenCalledWith("session", [
      first.descriptor.assetId,
      second.descriptor.assetId,
    ]);
    expect(store.list("session")).toHaveLength(2);
  });

  test("discards only staged images from the failed figure revision", async () => {
    const first = storedAsset();
    const persistent: PersistentFixture = {
      install: vi.fn(),
      readAsset: vi.fn(),
      stageMany: vi.fn(async (_sessionId: string, assets: StoredAsset[]) =>
        assets.map((asset) => ({
          descriptor: structuredClone(asset.descriptor),
          preview: Uint8Array.from(asset.preview),
        })),
      ),
      commitStaged: vi.fn(async () => undefined),
      discardStaged: vi.fn(async () => undefined),
    };
    const store = new AssetStore({ persistent });
    store.createSession("session", { kind: "patent", patentId: "patent" });
    await store.putPersistentManyStaged("session", [first], "operation-1");

    await store.discardPersistentStages("session", [first.descriptor.assetId], "operation-1");

    expect(persistent.discardStaged).toHaveBeenCalledWith(
      "session",
      [first.descriptor.assetId],
      "operation-1",
    );
    expect(store.list("session")).toEqual([]);
  });

  test("keeps a cached image while another paste operation still owns its stage", async () => {
    const first = storedAsset();
    const persistent: PersistentFixture = {
      install: vi.fn(),
      readAsset: vi.fn(),
      stageMany: vi.fn(async (_sessionId: string, assets: StoredAsset[]) =>
        assets.map((asset) => ({
          descriptor: structuredClone(asset.descriptor),
          preview: Uint8Array.from(asset.preview),
        })),
      ),
      commitStaged: vi.fn(async () => undefined),
      discardStaged: vi.fn(async () => undefined),
    };
    const store = new AssetStore({ persistent });
    store.createSession("session", { kind: "patent", patentId: "patent" });
    await store.putPersistentManyStaged("session", [first], "operation-1");
    await store.putPersistentManyStaged("session", [first], "operation-2");

    await store.discardPersistentStages("session", [first.descriptor.assetId], "operation-1");
    expect(store.get("session", first.descriptor.assetId)).toBeDefined();

    await store.discardPersistentStages("session", [first.descriptor.assetId], "operation-2");
    expect(store.get("session", first.descriptor.assetId)).toBeUndefined();
  });
});

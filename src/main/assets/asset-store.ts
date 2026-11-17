import { randomUUID } from "node:crypto";
import { type AssetDescriptor, AssetDescriptorSchema } from "../../shared/document/model.js";
import type { DrawingTileRaster } from "../../shared/drawing-markup/tiles.js";
import type { ImportedAsset } from "../../shared/ipc/contract.js";
import { openDrawingTileReader } from "./drawing-tiles.js";

export type StoredAsset = {
  descriptor: AssetDescriptor;
  original: Uint8Array;
  preview: Uint8Array;
};

export type AssetOwner =
  | { kind: "library-document"; libraryDocumentId: string }
  | { kind: "patent"; patentId: string }
  | { kind: "patent-template"; templateId: string };

export type PersistentAssetStore = {
  install(owner: AssetOwner, asset: StoredAsset): Promise<ImportedAsset>;
  readAsset(assetId: string): Promise<StoredAsset>;
  stageMany?(
    sessionId: string,
    assets: StoredAsset[],
    operationId?: string,
  ): Promise<ImportedAsset[]>;
  commitStaged?(sessionId: string, assetIds: readonly string[]): Promise<void>;
  discardStaged?(
    sessionId: string,
    assetIds: readonly string[],
    operationId?: string,
  ): Promise<void>;
  adopt?(owner: AssetOwner, assetId: string): Promise<void>;
};

type AssetSession = {
  owner: AssetOwner | null;
  assets: Map<string, StoredAsset>;
  stagedOperations: Map<string, Map<string, { wasCached: boolean }>>;
  drawingReaders: Map<string, ReturnType<typeof openDrawingTileReader>>;
};

function cloneAsset(asset: StoredAsset): StoredAsset {
  return {
    descriptor: structuredClone(asset.descriptor),
    original: Uint8Array.from(asset.original),
    preview: Uint8Array.from(asset.preview),
  };
}

function cloneImported(asset: ImportedAsset): ImportedAsset {
  return {
    descriptor: structuredClone(asset.descriptor),
    preview: Uint8Array.from(asset.preview),
  };
}

export class AssetStore {
  readonly #sessions = new Map<string, AssetSession>();
  readonly #persistent: PersistentAssetStore | undefined;

  constructor(options: { persistent?: PersistentAssetStore } = {}) {
    this.#persistent = options.persistent;
  }

  createSession(sessionId: string, owner: AssetOwner | null = null): void {
    if (!this.#sessions.has(sessionId)) {
      this.#sessions.set(sessionId, {
        owner,
        assets: new Map(),
        stagedOperations: new Map(),
        drawingReaders: new Map(),
      });
    }
  }

  put(sessionId: string, asset: StoredAsset): void {
    const session = this.#requireSession(sessionId);
    const validated = AssetDescriptorSchema.parse(asset.descriptor);
    this.#cacheAsset(session, cloneAsset({ ...asset, descriptor: validated }));
  }

  async putPersistent(sessionId: string, asset: StoredAsset): Promise<ImportedAsset> {
    const session = this.#requireSession(sessionId);
    if (!this.#persistent || session.owner === null) {
      this.put(sessionId, asset);
      return {
        descriptor: structuredClone(asset.descriptor),
        preview: Uint8Array.from(asset.preview),
      };
    }
    const imported = await this.#persistent.install(session.owner, cloneAsset(asset));
    this.#cacheAsset(
      session,
      cloneAsset({
        descriptor: imported.descriptor,
        original: asset.original,
        preview: imported.preview,
      }),
    );
    return cloneImported(imported);
  }

  async putPersistentManyStaged(
    sessionId: string,
    assets: StoredAsset[],
    operationId: string = randomUUID(),
  ): Promise<ImportedAsset[]> {
    const session = this.#requireSession(sessionId);
    if (assets.length === 0) return [];
    if (!this.#persistent) {
      for (const asset of assets) this.put(sessionId, asset);
      return assets.map((asset) => ({
        descriptor: structuredClone(asset.descriptor),
        preview: Uint8Array.from(asset.preview),
      }));
    }
    if (!this.#persistent.stageMany) {
      throw new Error("持久资源存储不支持批次暂存。");
    }
    const imported = await this.#persistent.stageMany(
      sessionId,
      assets.map(cloneAsset),
      operationId,
    );
    if (imported.length !== assets.length) {
      throw new Error("批次暂存返回的资源数量不一致。");
    }
    const operation = new Map<string, { wasCached: boolean }>();
    imported.forEach((item, index) => {
      const source = assets[index];
      if (!source) throw new Error("批次资源不存在。");
      if (!operation.has(item.descriptor.assetId)) {
        operation.set(item.descriptor.assetId, {
          wasCached:
            session.assets.has(item.descriptor.assetId) &&
            ![...session.stagedOperations.values()].some((staged) =>
              staged.has(item.descriptor.assetId),
            ),
        });
      }
      this.#cacheAsset(
        session,
        cloneAsset({
          descriptor: item.descriptor,
          original: source.original,
          preview: item.preview,
        }),
      );
    });
    session.stagedOperations.set(operationId, operation);
    return imported.map(cloneImported);
  }

  async commitPersistentStages(sessionId: string, assetIds: readonly string[]): Promise<void> {
    const session = this.#requireSession(sessionId);
    const requestedIds = new Set(assetIds);
    const stagedIds = [
      ...new Set(
        [...session.stagedOperations.values()].flatMap((operation) =>
          [...operation.keys()].filter((assetId) => requestedIds.has(assetId)),
        ),
      ),
    ];
    if (stagedIds.length === 0) return;
    await this.#persistent?.commitStaged?.(sessionId, stagedIds);
    for (const [operationId, operation] of session.stagedOperations) {
      for (const assetId of stagedIds) operation.delete(assetId);
      if (operation.size === 0) session.stagedOperations.delete(operationId);
    }
  }

  async discardPersistentStages(
    sessionId: string,
    assetIds: readonly string[],
    operationId?: string,
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    const operations = operationId
      ? [[operationId, session.stagedOperations.get(operationId)] as const]
      : [...session.stagedOperations.entries()];
    const requestedIds = new Set(assetIds);
    const stagedIds = [
      ...new Set(
        operations.flatMap(([, operation]) =>
          operation ? [...operation.keys()].filter((assetId) => requestedIds.has(assetId)) : [],
        ),
      ),
    ];
    if (stagedIds.length === 0) return;
    const wasCached = new Map(
      stagedIds.map((assetId) => [
        assetId,
        operations.some(([, operation]) => operation?.get(assetId)?.wasCached === true),
      ]),
    );
    await this.#persistent?.discardStaged?.(sessionId, stagedIds, operationId);
    for (const [currentOperationId, operation] of operations) {
      if (!operation) continue;
      for (const assetId of stagedIds) operation.delete(assetId);
      if (operation.size === 0) session.stagedOperations.delete(currentOperationId);
    }
    for (const assetId of stagedIds) {
      const stillStaged = [...session.stagedOperations.values()].some((operation) =>
        operation.has(assetId),
      );
      if (!stillStaged && !wasCached.get(assetId)) this.#removeAsset(session, assetId);
    }
  }

  async discardAllPersistentStages(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    for (const [operationId, operation] of [...session.stagedOperations]) {
      await this.discardPersistentStages(sessionId, [...operation.keys()], operationId);
    }
  }

  adopt(sessionId: string, asset: StoredAsset): void {
    const session = this.#requireSession(sessionId);
    const validated = AssetDescriptorSchema.parse(asset.descriptor);
    this.#cacheAsset(session, cloneAsset({ ...asset, descriptor: validated }));
  }

  get(sessionId: string, assetId: string): StoredAsset | undefined {
    const asset = this.#requireSession(sessionId).assets.get(assetId);
    return asset ? cloneAsset(asset) : undefined;
  }

  async getOrLoad(sessionId: string, assetId: string): Promise<StoredAsset | undefined> {
    const asset = await this.#loadPrivate(sessionId, assetId);
    return asset ? cloneAsset(asset) : undefined;
  }

  async #loadPrivate(sessionId: string, assetId: string): Promise<StoredAsset | undefined> {
    const session = this.#requireSession(sessionId);
    const cached = session.assets.get(assetId);
    if (cached) return cached;
    if (!this.#persistent) return undefined;
    try {
      const loaded = await this.#persistent.readAsset(assetId);
      if (this.#sessions.get(sessionId) !== session) throw new Error("资源会话不存在");
      const existing = session.assets.get(assetId);
      if (existing) return existing;
      const owned = cloneAsset(loaded);
      this.#cacheAsset(session, owned);
      return owned;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "NOT_FOUND"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async #drawingReader(sessionId: string, assetId: string) {
    const session = this.#requireSession(sessionId);
    const asset = await this.#loadPrivate(sessionId, assetId);
    if (this.#sessions.get(sessionId) !== session) throw new Error("资源会话不存在");
    if (!asset || asset.descriptor.kind !== "drawing-tiles")
      throw new Error("分块图纸资源不存在。");
    let reader = session.drawingReaders.get(assetId);
    if (!reader) {
      reader = openDrawingTileReader(asset.original);
      session.drawingReaders.set(assetId, reader);
      const current = reader;
      void reader.catch(() => {
        if (session.drawingReaders.get(assetId) === current) session.drawingReaders.delete(assetId);
      });
    }
    return reader;
  }

  async readDrawingTile(
    sessionId: string,
    assetId: string,
    tileId: string,
    raster?: DrawingTileRaster,
  ) {
    const reader = await this.#drawingReader(sessionId, assetId);
    return raster ? reader.rasterize(tileId, raster) : reader.read(tileId);
  }

  async readDrawingTileIndex(sessionId: string, assetId: string) {
    return (await this.#drawingReader(sessionId, assetId)).index();
  }

  async descriptorOrLoad(sessionId: string, assetId: string) {
    const asset = await this.#loadPrivate(sessionId, assetId);
    return asset ? structuredClone(asset.descriptor) : undefined;
  }

  #closeDrawingReader(session: AssetSession, assetId: string) {
    const reader = session.drawingReaders.get(assetId);
    session.drawingReaders.delete(assetId);
    if (reader)
      void reader.then(
        (value) => value.close(),
        () => {},
      );
  }

  #cacheAsset(session: AssetSession, asset: StoredAsset) {
    this.#closeDrawingReader(session, asset.descriptor.assetId);
    session.assets.set(asset.descriptor.assetId, asset);
  }

  #removeAsset(session: AssetSession, assetId: string) {
    this.#closeDrawingReader(session, assetId);
    session.assets.delete(assetId);
  }

  async previewOrLoad(sessionId: string, assetId: string): Promise<Uint8Array | undefined> {
    const asset = await this.getOrLoad(sessionId, assetId);
    return asset ? Uint8Array.from(asset.preview) : undefined;
  }

  list(sessionId: string): StoredAsset[] {
    return [...this.#requireSession(sessionId).assets.values()].map(cloneAsset);
  }

  remove(sessionId: string, assetId: string): void {
    this.#removeAsset(this.#requireSession(sessionId), assetId);
  }

  destroySession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session)
      for (const id of session.drawingReaders.keys()) this.#closeDrawingReader(session, id);
    this.#sessions.delete(sessionId);
  }

  #requireSession(sessionId: string): AssetSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`资源会话不存在：${sessionId}`);
    return session;
  }
}

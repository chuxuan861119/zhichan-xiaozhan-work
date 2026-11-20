import type { AssetDescriptor } from "../../../../shared/document/model";
import {
  DesignEditorProjectDataSchema,
  DesignEditorSourceSchema,
  type PatentApi,
} from "../../../../shared/ipc/contract";
import { TemporaryLayerProjectSchema } from "../../../../shared/ipc/temporary-images";
import {
  type DesignPatentView,
  isAssignedDesignView,
} from "../../../../shared/patent/design-patent";
import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksRasterWire } from "./klecks-document-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksProjectWire } from "./klecks-project-port";

type Options = {
  enabled?(): boolean;
  documents: Pick<
    KlecksFrameClient["documents"],
    "sync" | "activate" | "openRaster" | "openProject"
  >;
  assets: Pick<PatentApi["assets"], "prepareDesignEditorSource" | "readDesignEditorProject">;
  changed?(): void;
  chooseRecovery?(
    view: DesignPatentView,
    signal: AbortSignal,
  ): Promise<"recovery" | "saved" | "cancel">;
};
type TemporaryActions = {
  save(identity: KlecksPortIdentity): Promise<boolean>;
  close(): Promise<boolean>;
};
export class KlecksCaseDocuments {
  private entries = new Map<string, Entry>();
  private basis = new Map<string, Entry>();
  // Deliberately separate from case entries: no asset/editor references or persistence targets.
  private temporary = new Map<string, TemporaryEntry>();
  private temporaryActions: TemporaryActions | null = null;
  private generation = 0;
  private syncTail: Promise<void> = Promise.resolve();
  private syncIntent = 0;
  private selectionIntent = 0;
  private loadSerial = 0;
  private load: { target: KlecksPortIdentity; abort: AbortController } | null = null;
  private activeId: string | null = null;
  private requestedId: string | null = null;
  private loadingId: string | null = null;
  private readonly errors = new Map<string, string>();
  private syncError: string | null = null;
  private synchronized = false;
  private pendingReconciles = 0;
  private closed = false;
  constructor(
    readonly sessionId: string,
    private readonly options: Options,
  ) {
    if (!sessionId) throw new Error("缺少案件会话。");
  }
  snapshot(): {
    ids: string[];
    activeId: string | null;
    requestedId: string | null;
    loadingId: string | null;
    errors: Record<string, string>;
    syncError: string | null;
  } {
    return {
      ids: [...this.entries.keys(), ...this.temporary.keys()],
      activeId: this.activeId,
      requestedId: this.requestedId,
      loadingId: this.loadingId,
      errors: Object.fromEntries(this.errors),
      syncError: this.syncError,
    };
  }
  reconcile(
    views: readonly DesignPatentView[],
    assets: readonly AssetDescriptor[],
    preferredId?: string,
    lockToken?: string,
    refreshIds?: readonly string[],
  ): Promise<boolean> {
    return this.synchronize(views, assets, preferredId, undefined, lockToken, refreshIds);
  }
  temporaryDocuments(): { viewId: string; name: string }[] {
    return [...this.temporary].map(([viewId, entry]) => ({ viewId, name: entry.name }));
  }
  isTemporary(id: string): boolean {
    return this.temporary.has(id);
  }
  bindTemporaryActions(actions: TemporaryActions): () => void {
    this.temporaryActions = actions;
    return () => {
      if (this.temporaryActions === actions) this.temporaryActions = null;
    };
  }
  async saveTemporary(identity: KlecksPortIdentity): Promise<boolean> {
    if (!this.isTemporary(identity.viewId) || !this.isCurrent(identity)) return false;
    return this.temporaryActions?.save(identity) ?? false;
  }
  async prepareTemporaryClose(): Promise<boolean> {
    if (!this.temporary.size) return true;
    return this.temporaryActions?.close() ?? false;
  }
  async addTemporaryRaster(name: string, source: KlecksRasterWire): Promise<string> {
    if (
      !name.trim() ||
      name.length > 200 ||
      !source.bytes.byteLength ||
      source.bytes.byteLength > 50 * 1024 * 1024 ||
      !Number.isSafeInteger(source.widthPx) ||
      !Number.isSafeInteger(source.heightPx) ||
      source.widthPx < 1 ||
      source.heightPx < 1 ||
      source.widthPx > 10000 ||
      source.heightPx > 10000 ||
      source.widthPx * source.heightPx > 40_000_000
    )
      throw new Error("临时图片名称或尺寸无效。");
    const id = `temporary-${crypto.randomUUID()}`;
    const captured = structuredClone(source);
    await this.mutateTemporary(() => {
      if (this.temporary.size >= 16) throw new Error("最多同时打开16张临时图片。");
      this.temporary.set(id, {
        name,
        source: captured,
        generation: ++this.generation,
        runtime: { ready: false },
      });
    });
    await this.activate(id);
    return id;
  }
  /** Only normalized, bounded raster-layer projects enter the isolated temporary registry. */
  async addTemporaryProject(name: string, project: KlecksProjectWire): Promise<string> {
    if (!name.trim() || name.length > 200) throw new Error("临时工程名称无效。");
    const captured = structuredClone(TemporaryLayerProjectSchema.parse(project));
    const id = `temporary-${crypto.randomUUID()}`;
    await this.mutateTemporary(() => {
      if (this.temporary.size >= 16) throw new Error("最多同时打开16张临时图片。");
      this.temporary.set(id, {
        name,
        project: captured,
        source: null,
        generation: ++this.generation,
        runtime: { ready: false },
      });
    });
    await this.activate(id);
    return id;
  }
  /** The caller owns the export/discard/cancel decision before invoking this method. */
  async removeTemporary(id: string): Promise<void> {
    await this.mutateTemporary(() => {
      if (!this.temporary.has(id)) throw new Error("只能关闭临时图片。");
      if (this.load?.target.viewId === id) {
        this.load.abort.abort();
        this.loadSerial++;
        this.load = null;
        this.loadingId = null;
      }
      this.temporary.delete(id);
      this.errors.delete(id);
      if (this.activeId === id) this.activeId = null;
      if (this.requestedId === id) this.requestedId = null;
    }, id);
    if (!this.activeId) {
      const remaining = this.snapshot().ids;
      const next = remaining.at(-1);
      if (next) await this.activate(next);
    }
  }
  private wireIdentities(entries = this.entries) {
    return [...entries, ...this.temporary].map(([viewId, entry]) => ({
      viewId,
      generation: entry.generation,
    }));
  }
  private mutateTemporary(mutate: () => void, removeId?: string): Promise<void> {
    this.pendingReconciles++;
    const work = this.syncTail.then(async () => {
      if (this.closed) throw cancelled();
      if (removeId && !this.temporary.has(removeId)) throw new Error("只能关闭临时图片。");
      if (!removeId) mutate();
      try {
        // Keep the editable document reachable until the engine accepts its removal.
        const identities = this.wireIdentities().filter((item) => item.viewId !== removeId);
        if (!(await this.options.documents.sync(this.sessionId, identities)))
          throw new Error("图片集合更新未获确认，请重试；现有图片仍保留。");
        if (this.closed) throw cancelled();
        if (removeId) mutate();
        this.syncError = null;
        this.synchronized = true;
      } catch (error) {
        this.syncError = message(error);
        if (removeId && !this.closed) {
          // Reconfirm the retained collection so a rejected close does not also
          // strand the document behind a collection error and prevent export.
          try {
            if (await this.options.documents.sync(this.sessionId, this.wireIdentities())) {
              this.syncError = null;
              this.synchronized = true;
            }
          } catch {
            /* Keep the original error and all retained document records. */
          }
        }
        throw error;
      } finally {
        this.emit();
      }
    });
    this.syncTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work.finally(() => {
      this.pendingReconciles--;
    });
  }
  /** Call only after an explicit reset/discard decision has durably committed. */
  reinitialize(
    target: KlecksPortIdentity,
    views: readonly DesignPatentView[],
    assets: readonly AssetDescriptor[],
    lockToken?: string,
  ): Promise<boolean> {
    return this.synchronize(views, assets, target.viewId, { ...target }, lockToken);
  }
  private synchronize(
    views: readonly DesignPatentView[],
    assets: readonly AssetDescriptor[],
    preferredId?: string,
    reset?: KlecksPortIdentity,
    lockToken?: string,
    refreshIds: readonly string[] = [],
  ): Promise<boolean> {
    const captured = structuredClone({ views: views.filter(isAssignedDesignView), assets });
    this.pendingReconciles++;
    const intent = ++this.syncIntent,
      selection = this.selectionIntent;
    let autoTarget: string | null = null;
    const work = this.syncTail.then(async () => {
      if (this.closed) throw cancelled();
      if (
        reset &&
        (!this.isCurrent(reset) || !captured.views.some((view) => view.viewId === reset.viewId))
      )
        throw cancelled();
      if (new Set(captured.views.map((view) => view.viewId)).size !== captured.views.length)
        throw new Error("图片文档标识重复。");
      const byId = new Map(captured.assets.map((asset) => [asset.assetId, asset]));
      const next = new Map<string, Entry>();
      for (const view of captured.views) {
        const asset = byId.get(view.assetId);
        const key = JSON.stringify([
          view.assetId,
          asset?.kind,
          asset?.mediaType,
          asset?.sha256,
          asset?.widthPx,
          asset?.heightPx,
          view.operations,
        ]);
        const previous = this.basis.get(view.viewId);
        const retained =
          previous?.key === key &&
          reset?.viewId !== view.viewId &&
          !refreshIds.includes(view.viewId);
        next.set(view.viewId, {
          view,
          asset,
          key,
          generation: retained ? previous.generation : ++this.generation,
          runtime: retained ? previous.runtime : { ready: false },
        });
      }
      const oldTarget = this.requestedId ?? this.activeId;
      const retainedTemporary = oldTarget && this.temporary.has(oldTarget);
      const added = [...next.keys()].filter((id) => !this.entries.has(id));
      const oldIndex = Math.max(0, [...this.entries.keys()].indexOf(oldTarget ?? ""));
      const nextIds = [...next.keys(), ...this.temporary.keys()];
      const target =
        preferredId && next.has(preferredId)
          ? preferredId
          : (added[0] ??
            (retainedTemporary ? oldTarget : null) ??
            (oldTarget && next.has(oldTarget)
              ? oldTarget
              : (nextIds[Math.min(oldIndex, Math.max(0, nextIds.length - 1))] ?? null)));
      if (
        (preferredId && next.has(preferredId)) ||
        added.length ||
        !oldTarget ||
        (!next.has(oldTarget) && !retainedTemporary) ||
        this.entries.get(oldTarget)?.generation !== next.get(oldTarget)?.generation
      )
        autoTarget = target;
      this.basis = next;
      if (
        this.load &&
        !this.temporary.has(this.load.target.viewId) &&
        (next.get(this.load.target.viewId)?.generation !== this.load.target.generation ||
          (!this.entries.get(this.load.target.viewId)?.runtime.ready &&
            JSON.stringify(next.get(this.load.target.viewId)?.view.editor) !==
              JSON.stringify(this.entries.get(this.load.target.viewId)?.view.editor)))
      ) {
        this.load.abort.abort();
        this.loadSerial++;
        this.load = null;
        this.loadingId = null;
      }
      try {
        const previousIds = [...this.entries.keys()],
          nextIds = [...next.keys()];
        const unchanged =
          this.synchronized &&
          !this.syncError &&
          previousIds.length === nextIds.length &&
          previousIds.every(
            (id, index) =>
              id === nextIds[index] &&
              this.entries.get(id)?.generation === next.get(id)?.generation,
          );
        if (!unchanged)
          await this.options.documents.sync(
            this.sessionId,
            this.wireIdentities(next),
            ...(lockToken !== undefined ? ([lockToken] as [string]) : []),
          );
        if (this.closed) throw cancelled();
        if (
          this.activeId &&
          !this.temporary.has(this.activeId) &&
          this.entries.get(this.activeId)?.generation !== next.get(this.activeId)?.generation
        )
          this.activeId = null;
        this.entries = next;
        this.synchronized = true;
        this.syncError = null;
        for (const id of this.errors.keys())
          if (!next.has(id) && !this.temporary.has(id)) this.errors.delete(id);
        if (!next.size && !this.temporary.size) {
          this.requestedId = null;
          this.activeId = null;
        }
        this.emit();
      } catch (error) {
        this.syncError = message(error);
        this.emit();
        throw error;
      }
    });
    // Keep a serial, recoverable synchronization tail. A lost acknowledgement retries the same generations.
    this.syncTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work
      .then(() => {
        if (this.closed || intent !== this.syncIntent) return false;
        return autoTarget &&
          selection === this.selectionIntent &&
          (this.options.enabled?.() ?? true)
          ? this.open(autoTarget)
          : true;
      })
      .finally(() => {
        this.pendingReconciles--;
      });
  }
  activate(id: string): Promise<boolean> {
    this.selectionIntent++;
    return this.open(id);
  }
  identity(id: string): KlecksPortIdentity | null {
    const entry = this.entries.get(id) ?? this.temporary.get(id);
    return !this.closed && entry
      ? { sessionId: this.sessionId, viewId: id, generation: entry.generation }
      : null;
  }
  loadedIdentities(): KlecksPortIdentity[] {
    if (this.closed || this.loadingId || this.syncError || this.pendingReconciles)
      throw new Error("图片集合尚未稳定，暂时不能生成检查点。");
    return [...this.entries]
      .filter(([, entry]) => entry.runtime.ready)
      .map(([id, entry]) => ({
        sessionId: this.sessionId,
        viewId: id,
        generation: entry.generation,
      }));
  }
  hasLoadedCaseDocuments(): boolean {
    return [...this.entries.values()].some((entry) => entry.runtime.ready);
  }
  isCurrent(target: KlecksPortIdentity): boolean {
    return (
      !this.closed &&
      !this.syncError &&
      target.sessionId === this.sessionId &&
      (this.basis.get(target.viewId) ?? this.temporary.get(target.viewId))?.generation ===
        target.generation
    );
  }
  private async open(id: string): Promise<boolean> {
    const serial = ++this.loadSerial;
    this.load?.abort.abort();
    this.load = null;
    this.loadingId = null;
    this.requestedId = this.activeId;
    this.emit();
    let waiting: Promise<void>;
    do {
      waiting = this.syncTail;
      await waiting;
    } while (waiting !== this.syncTail);
    if (this.closed || serial !== this.loadSerial) return false;
    if (this.syncError) throw new Error(this.syncError);
    const entry = this.entries.get(id) ?? this.temporary.get(id),
      target = this.identity(id);
    if (!entry || !target) throw cancelled();
    const abort = new AbortController();
    this.load = { target, abort };
    const current = () =>
      !abort.signal.aborted && serial === this.loadSerial && this.isCurrent(target);
    this.requestedId = id;
    this.loadingId = id;
    this.errors.delete(id);
    this.emit();
    try {
      if (this.isTemporary(id)) {
        const temporary = entry as TemporaryEntry;
        if (!temporary.runtime.ready && !temporary.source && !temporary.project)
          throw new Error("临时图片来源已释放，请重新打开。");
        const opened = temporary.runtime.ready
          ? await this.options.documents.activate(target, { signal: abort.signal })
          : temporary.project
            ? await this.options.documents.openProject(target, temporary.project, false, {
                signal: abort.signal,
                isSaved: true,
              })
            : await this.options.documents.openRaster(target, temporary.name, temporary.source!, {
                signal: abort.signal,
              });
        if (!current() || !opened) return false;
        temporary.runtime.ready = true;
        temporary.source = null; // The engine owns editable pixels now; do not retain another full PNG per tab.
        temporary.project = null;
        this.activeId = id;
        return true;
      }
      const caseEntry = entry as Entry;
      return await this.openCase(caseEntry, target, abort, current, id);
    } catch (error) {
      if (!current()) return false;
      this.errors.set(id, message(error));
      throw error;
    } finally {
      if (serial === this.loadSerial) {
        this.load = null;
        this.loadingId = null;
        this.emit();
      }
    }
  }
  private async openCase(
    entry: Entry,
    target: KlecksPortIdentity,
    abort: AbortController,
    current: () => boolean,
    id: string,
  ): Promise<boolean> {
    let projectRef = entry.view.editor?.saved ?? entry.view.editor?.applied;
    let isSaved = true;
    if (!entry.runtime.ready && entry.view.editor?.recovery) {
      if (entry.view.editor.sourceAssetId !== entry.view.assetId)
        throw new Error("工程来源与原图不一致。");
      if (!this.options.chooseRecovery) throw new Error("请选择要打开的恢复版本。");
      const choice = await this.options.chooseRecovery(structuredClone(entry.view), abort.signal);
      if (!current() || choice === "cancel") return false;
      if (choice !== "saved" && choice !== "recovery") throw new Error("恢复版本选择无效。");
      projectRef = choice === "recovery" ? entry.view.editor.recovery : entry.view.editor.saved;
      isSaved = choice !== "recovery";
    }
    let opened: boolean;
    if (entry.runtime.ready)
      opened = await this.options.documents.activate(target, { signal: abort.signal });
    else if (projectRef) {
      if (entry.view.editor?.sourceAssetId !== entry.view.assetId)
        throw new Error("工程来源与原图不一致。");
      const read = this.options.assets.readDesignEditorProject;
      if (!read) throw new Error("当前平台不支持读取分层工程。");
      const result = await read.call(this.options.assets, {
        sessionId: this.sessionId,
        assetId: projectRef.projectAssetId,
      });
      if (!current()) return false;
      if (!result.ok) throw result.error;
      const project = DesignEditorProjectDataSchema.parse(result.value);
      const isApplied = projectRef.projectAssetId === entry.view.editor?.applied?.projectAssetId;
      opened = await this.options.documents.openProject(target, project, isApplied, {
        signal: abort.signal,
        isSaved,
      });
    } else {
      if (!entry.asset) throw new Error("原始图片资源不存在。");
      const prepare = this.options.assets.prepareDesignEditorSource;
      if (!prepare) throw new Error("当前平台不支持准备编辑原图。");
      const result = await prepare.call(this.options.assets, {
        sessionId: this.sessionId,
        assetId: entry.view.assetId,
        operations: entry.view.operations,
      });
      if (!current()) return false;
      if (!result.ok) throw result.error;
      const source = DesignEditorSourceSchema.parse(result.value);
      opened = await this.options.documents.openRaster(
        target,
        entry.asset.originalName.slice(0, 200),
        source,
        { signal: abort.signal },
      );
    }
    if (!current() || !opened) return false;
    entry.runtime.ready = true;
    this.activeId = id;
    return true;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.loadSerial++;
    this.load?.abort.abort();
    this.load = null;
    this.entries.clear();
    this.basis.clear();
    this.temporary.clear();
    this.temporaryActions = null;
    this.errors.clear();
    this.activeId = null;
    this.requestedId = null;
    this.loadingId = null;
  }
  private emit(): void {
    if (!this.closed) this.options.changed?.();
  }
}
type Entry = {
  view: DesignPatentView;
  asset: AssetDescriptor | undefined;
  key: string;
  generation: number;
  runtime: { ready: boolean };
};
type TemporaryEntry = {
  project?: KlecksProjectWire | null;
  name: string;
  source: KlecksRasterWire | null;
  generation: number;
  runtime: { ready: boolean };
};
const cancelled = () => ({ code: "CANCELLED", message: "图片编辑会话已关闭或图片不存在。" });
function message(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "图片加载失败，请重试。";
}

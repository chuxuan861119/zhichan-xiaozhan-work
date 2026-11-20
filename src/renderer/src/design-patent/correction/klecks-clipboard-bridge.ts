import type { ClipboardImage, PatentApi } from "../../../../shared/ipc/contract";

type ClipboardEngine<T> = {
  copy(cut?: boolean, merged?: boolean): void;
  exportClipboardPng(): Promise<ClipboardImage | null>;
  captureTarget(): T;
  pasteExternalPng(image: ClipboardImage, target: T): Promise<boolean>;
};
export type ClipboardCopyStatus = "written" | "unavailable" | "stale" | "failed";

/** Coordinates explicit platform actions; never polls or automatically reads the OS clipboard. */
export class KlecksClipboardBridge<T> {
  private revision = 0;
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly engine: ClipboardEngine<T>,
    private readonly platform: Partial<PatentApi["clipboard"]>,
  ) {}

  async copy(cut = false, merged = false): Promise<ClipboardCopyStatus> {
    if (this.closed) throw new Error("图片编辑器已关闭。");
    // Internal copy/cut is synchronous and remains usable even when native export fails.
    this.engine.copy(cut, merged);
    const revision = ++this.revision;
    if (!this.platform.writeImage) return "unavailable";
    try {
      const image = await this.engine.exportClipboardPng();
      if (this.closed || revision !== this.revision) return "stale";
      if (!image) return "unavailable";
      const write = this.writes.then(async (): Promise<ClipboardCopyStatus> => {
        if (this.closed || revision !== this.revision) return "stale";
        const result = await this.platform.writeImage?.(image);
        return result?.ok ? "written" : "failed";
      });
      this.writes = write.catch(() => undefined);
      return await write;
    } catch {
      return this.closed || revision !== this.revision ? "stale" : "failed";
    }
  }

  async pasteExternal(): Promise<boolean> {
    if (this.closed) throw new Error("图片编辑器已关闭。");
    const target = this.engine.captureTarget();
    const revision = this.revision;
    if (!this.platform.readImage)
      throw new Error("当前平台不支持系统图片剪贴板，请从图片整理导入。");
    const result = await this.platform.readImage();
    if (this.closed || revision !== this.revision) return false;
    if (!result.ok) throw new Error(result.error.message);
    if (!result.value) return false;
    return this.engine.pasteExternalPng(result.value, target);
  }

  dispose(): void {
    this.closed = true;
    this.revision++;
  }
}

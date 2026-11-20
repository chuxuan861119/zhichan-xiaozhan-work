import type { ClipboardImage, PatentApi } from "../../../../shared/ipc/contract";
import type { KlecksFrameClient } from "./klecks-frame-client";
export type KlecksClipboardAction = "copy" | "copyMerged" | "cut" | "paste" | "pasteInPlace";
/** OS access occurs only after an explicit user command, never on focus or polling. */
export class KlecksNativeClipboard {
  private closed = false;
  private revision = 0;
  private lastWritten: ClipboardImage | null = null;
  private preferInternal = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly frame: KlecksFrameClient,
    private readonly platform: Partial<PatentApi["clipboard"]>,
    private readonly warn: (message: string) => void,
  ) {}
  async execute(action: KlecksClipboardAction): Promise<boolean> {
    if (this.closed || !this.frame.clipboard) throw new Error("图片剪贴板不可用。");
    const state = this.frame.state.snapshot(),
      target = state?.identity;
    if (!state || !target || state.pending || state.locked) return false;
    const current = () => {
      const latest = this.frame.state.snapshot();
      return (
        !this.closed &&
        latest?.identity?.sessionId === target.sessionId &&
        latest.identity.viewId === target.viewId &&
        latest.identity.generation === target.generation &&
        latest.checkpointRevision === state.checkpointRevision &&
        !latest.pending &&
        !latest.locked
      );
    };
    if (action === "copy" || action === "copyMerged" || action === "cut") {
      const revision = ++this.revision;
      const image = await this.frame.clipboard.copy(
        target,
        state.checkpointRevision,
        action === "cut",
        action === "copyMerged",
      );
      if (this.closed || revision !== this.revision) return false;
      this.preferInternal = true;
      if (!image || !this.platform.writeImage) {
        this.warn("已保留编辑器内的复制内容；当前平台无法写入系统图片剪贴板。");
        return true;
      }
      const write = this.writes.then(async () => {
        if (this.closed || revision !== this.revision) return false;
        const result = await this.platform.writeImage!(image);
        if (result.ok) {
          this.lastWritten = { ...image, bytes: Uint8Array.from(image.bytes) };
          this.preferInternal = false;
        } else this.warn("系统剪贴板写入失败，仍可在本案件图片之间粘贴。");
        return true;
      });
      this.writes = write.catch(() => {});
      return await write;
    }
    if (this.preferInternal || !this.platform.readImage)
      return this.frame.clipboard.pasteInternal(
        target,
        state.checkpointRevision,
        action === "pasteInPlace",
      );
    const revision = this.revision,
      result = await this.platform.readImage();
    if (!current() || revision !== this.revision) return false;
    if (!result.ok) throw new Error(result.error.message);
    const image = result.value;
    if (!image)
      return this.frame.clipboard.pasteInternal(
        target,
        state.checkpointRevision,
        action === "pasteInPlace",
      );
    const own =
      this.lastWritten &&
      image.width === this.lastWritten.width &&
      image.height === this.lastWritten.height &&
      image.bytes.byteLength === this.lastWritten.bytes.byteLength &&
      image.bytes.every((value, index) => value === this.lastWritten!.bytes[index]);
    if (own)
      return this.frame.clipboard.pasteInternal(
        target,
        state.checkpointRevision,
        action === "pasteInPlace",
      );
    return this.frame.clipboard.paste(target, state.checkpointRevision, image);
  }
  dispose() {
    this.closed = true;
    this.revision++;
    this.lastWritten = null;
  }
}

export type KlecksDroppedImage = { name: string; bytes: Uint8Array };
const MAX_BYTES = 50 * 1024 ** 2,
  MAX_TOTAL = 100 * 1024 ** 2;
export function isKlecksDroppedImages(value: unknown): value is KlecksDroppedImage[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) return false;
  let total = 0;
  return value.every((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).length !== 2 ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 200 ||
      !ArrayBuffer.isView(item.bytes) ||
      Object.prototype.toString.call(item.bytes) !== "[object Uint8Array]" ||
      !item.bytes.byteLength ||
      item.bytes.byteLength > MAX_BYTES
    )
      return false;
    total += item.bytes.byteLength;
    return total <= MAX_TOTAL;
  });
}
/** The isolated canvas owns its DOM events; only explicit local file drops cross the private port. */
export function bindKlecksFileDrop(port: MessagePort, root: Document): () => void {
  let live = true,
    busy = false,
    sequence = 0;
  const over = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const drop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    const error = (message: string) => {
      if (live)
        port.postMessage({
          type: "klecks:files-dropped-error",
          version: 1,
          sequence: ++sequence,
          message,
        });
    };
    if (busy) {
      error("正在读取拖入图片，请稍后重试。");
      return;
    }
    if (
      files.length > 16 ||
      files.some((file) => !file.size || file.size > MAX_BYTES) ||
      files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL
    ) {
      error("一次最多拖入16张图片，单张不超过50 MiB，合计不超过100 MiB。");
      return;
    }
    busy = true;
    void (async () => {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!live) return;
        port.postMessage(
          {
            type: "klecks:files-dropped",
            version: 1,
            sequence: ++sequence,
            files: [{ name: file.name.slice(0, 200) || "image", bytes }],
          },
          [bytes.buffer],
        );
      }
    })()
      .catch(() => error("拖入图片读取失败，请使用文件菜单重新打开。"))
      .finally(() => {
        busy = false;
      });
  };
  root.addEventListener("dragover", over);
  root.addEventListener("drop", drop);
  return () => {
    live = false;
    root.removeEventListener("dragover", over);
    root.removeEventListener("drop", drop);
  };
}

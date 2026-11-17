import { type DragEvent, useRef, useState } from "react";
import { hasVisibleElement } from "../shared/focusable-elements";

function kind(name: string) {
  if (/\.dwg$/i.test(name)) return "dwg";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(png|jpe?g|bmp|tiff?)$/i.test(name)) return "image";
  return null;
}

export function useDrawingFileDrop({
  enabled,
  cadActive,
  onFiles,
  onError,
}: {
  enabled: boolean;
  cadActive: boolean;
  onFiles(files: File[]): void;
  onError(message: string): void;
}) {
  const [hint, setHint] = useState("");
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setHint("");
  };
  const available = () =>
    enabled &&
    !hasVisibleElement(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
    );
  function candidate(event: DragEvent<HTMLElement>) {
    if (!available() || !Array.from(event.dataTransfer.types).includes("Files")) return false;
    if (cadActive) return true;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) return files.some((file) => kind(file.name) === "dwg");
    // Browsers hide filenames until drop. Only claim DWG routing, not arbitrary files.
    return Array.from(event.dataTransfer.items ?? []).some(
      (item) => item.kind === "file" && (!item.type || /dwg|octet-stream/i.test(item.type)),
    );
  }
  return {
    hint: enabled ? hint : "",
    handlers: {
      onDragEnterCapture(event: DragEvent<HTMLElement>) {
        if (candidate(event)) depth.current++;
      },
      onDragOverCapture(event: DragEvent<HTMLElement>) {
        if (!candidate(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setHint(
          cadActive
            ? "松开后导入为新工作稿（DWG、PDF 或图片）"
            : "拖入 DWG：松开后打开 CAD标号并导入",
        );
      },
      onDragLeaveCapture() {
        if (--depth.current <= 0) reset();
      },
      onDragEndCapture: reset,
      onDropCapture(event: DragEvent<HTMLElement>) {
        reset();
        if (!available()) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        const kinds = files.map((file) => kind(file.name));
        if (!cadActive && !kinds.includes("dwg")) return;
        event.preventDefault();
        event.stopPropagation();
        if (kinds.includes(null)) {
          onError("仅支持 DWG、PDF、PNG、JPG、BMP、TIF 图纸文件。");
          return;
        }
        if (new Set(kinds).size !== 1) {
          onError("请分别拖入 DWG、PDF 或图片，不支持混合类型同时导入。");
          return;
        }
        onFiles(files);
      },
    },
  };
}

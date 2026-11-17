import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useState } from "react";
import type { EditorCommandBus } from "../../app/command-bus";
import type { OperationFeedback } from "../../shared/operation-feedback";
import { TransientFunctionRailSlot } from "../../shared/transient-function-rail-slot";
import { type RotationDirection, rotateImagePreservingSize } from "../image/image-transform";
import {
  canConvertInlineFigureToBlock,
  convertBlockFigureToInline,
  convertInlineFigureToBlock,
} from "../nodes/figure-commands";
import { clampFigureWidth } from "../nodes/figure-node";
import type { FigureSelectionSnapshot } from "../nodes/figure-selection";

type FigureRailPanelProps = {
  editorId: string;
  sessionId: string;
  commandBus: EditorCommandBus;
  onOperationFeedback(feedback: OperationFeedback): void;
};

function preserveFigureSelection(event: ReactPointerEvent<HTMLElement>): void {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
}

export function FigureRailPanel({
  editorId,
  sessionId,
  commandBus,
  onOperationFeedback,
}: FigureRailPanelProps) {
  const [selection, setSelection] = useState<FigureSelectionSnapshot>(() =>
    commandBus.getFigureSelection(editorId),
  );
  const [fileOperation, setFileOperation] = useState<"copy" | "save" | null>(null);

  useEffect(() => {
    setSelection(commandBus.getFigureSelection(editorId));
    return commandBus.subscribeFigureSelection(editorId, setSelection);
  }, [commandBus, editorId]);

  if (selection.kind === "none") {
    return <TransientFunctionRailSlot open={false}>{null}</TransientFunctionRailSlot>;
  }

  const editor = commandBus.getEditor(editorId);
  const blockLayoutUnavailable =
    selection.nodeType === "inlineFigure" && (!editor || !canConvertInlineFigureToBlock(editor));

  const updateAttributes = (attributes: Record<string, unknown>) => {
    const editor = commandBus.getEditor(editorId);
    if (!editor) return;
    editor.commands.updateAttributes(selection.nodeType, attributes);
    editor.commands.setNodeSelection(selection.position);
  };
  const rotate = (direction: RotationDirection) => {
    const ratio = Number(
      editor?.state?.doc.nodeAt(selection.position)?.attrs.sourceAspectRatio ?? 1,
    );
    const geometry = rotateImagePreservingSize(selection, ratio, direction);
    if (!geometry) {
      onOperationFeedback({
        tone: "error",
        title: "图片尺寸超出范围",
        message: "旋转后的宽度超出页面允许范围，请先调整图片大小。",
      });
      return;
    }
    updateAttributes(geometry);
  };
  const copyImage = async () => {
    if (fileOperation !== null) return;
    setFileOperation("copy");
    try {
      const result = await window.patentApi.assets.copyImages({
        sessionId,
        images: [
          {
            assetId: selection.assetId,
            rotationDeg: selection.rotationDeg,
            layout: selection.nodeType === "inlineFigure" ? "inline" : "block",
            widthMm: selection.widthMm,
            alignment: selection.alignment,
            label: "专利图片",
          },
        ],
      });
      onOperationFeedback(
        result.ok
          ? { tone: "success", title: "复制成功", message: "图片已复制到剪贴板。" }
          : { tone: "error", title: "复制失败", message: result.error.message },
      );
    } catch {
      onOperationFeedback({
        tone: "error",
        title: "复制失败",
        message: "无法写入剪贴板，请重试。",
      });
    } finally {
      setFileOperation(null);
    }
  };
  const saveImage = async () => {
    if (fileOperation !== null) return;
    setFileOperation("save");
    try {
      const result = await window.patentApi.assets.saveImage({
        sessionId,
        image: {
          assetId: selection.assetId,
          rotationDeg: selection.rotationDeg,
          label: "专利图片",
        },
      });
      if (!result.ok) {
        onOperationFeedback({ tone: "error", title: "另存失败", message: result.error.message });
      } else if (result.value) {
        onOperationFeedback({ tone: "success", title: "另存成功", message: "图片已保存。" });
      }
    } catch {
      onOperationFeedback({
        tone: "error",
        title: "另存失败",
        message: "无法保存图片，请重试。",
      });
    } finally {
      setFileOperation(null);
    }
  };

  return (
    <TransientFunctionRailSlot open>
      <section
        className="figure-rail-panel function-rail-transient-panel"
        aria-label="图片设置"
        onPointerDown={preserveFigureSelection}
      >
        <header>
          <strong>图片设置</strong>
          <span>{Math.round(selection.widthMm)} mm</span>
        </header>
        <label className="figure-rail-panel__width">
          宽度
          <input
            type="range"
            min="10"
            max="165"
            step="1"
            value={selection.widthMm}
            aria-label="图片宽度"
            onChange={(event) =>
              updateAttributes({ widthMm: clampFigureWidth(Number(event.target.value)) })
            }
          />
        </label>
        {selection.nodeType === "figure" ? (
          <fieldset className="figure-rail-panel__alignments">
            <legend>对齐方式</legend>
            {(["left", "center", "right"] as const).map((alignment) => (
              <button
                type="button"
                key={alignment}
                aria-label={
                  alignment === "left" ? "左对齐" : alignment === "center" ? "居中" : "右对齐"
                }
                aria-pressed={selection.alignment === alignment}
                onClick={() => updateAttributes({ alignment })}
              >
                {alignment === "left" ? "左" : alignment === "center" ? "中" : "右"}
              </button>
            ))}
          </fieldset>
        ) : null}
        <fieldset className="figure-rail-panel__actions">
          <legend>布局</legend>
          <button
            type="button"
            aria-pressed={selection.nodeType === "figure"}
            disabled={blockLayoutUnavailable}
            title={blockLayoutUnavailable ? "表格和列表中的图片需保留嵌入型布局" : undefined}
            onClick={() => {
              const editor = commandBus.getEditor(editorId);
              if (editor && selection.nodeType === "inlineFigure")
                convertInlineFigureToBlock(editor);
            }}
          >
            独立成行
          </button>
          <button
            type="button"
            aria-pressed={selection.nodeType === "inlineFigure"}
            onClick={() => {
              const editor = commandBus.getEditor(editorId);
              if (editor && selection.nodeType === "figure") convertBlockFigureToInline(editor);
            }}
          >
            嵌入型
          </button>
        </fieldset>
        <fieldset className="figure-rail-panel__actions">
          <legend>文件</legend>
          <button type="button" disabled={fileOperation !== null} onClick={() => void copyImage()}>
            {fileOperation === "copy" ? "复制中…" : "复制图片"}
          </button>
          <button type="button" disabled={fileOperation !== null} onClick={() => void saveImage()}>
            {fileOperation === "save" ? "保存中…" : "另存为图片"}
          </button>
        </fieldset>
        <fieldset className="figure-rail-panel__actions">
          <legend>旋转</legend>
          <button type="button" aria-label="向左旋转90°" onClick={() => rotate("left")}>
            左转90°
          </button>
          <button type="button" aria-label="向右旋转90°" onClick={() => rotate("right")}>
            右转90°
          </button>
        </fieldset>
      </section>
    </TransientFunctionRailSlot>
  );
}

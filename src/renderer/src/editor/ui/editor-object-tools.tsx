import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Columns3,
  Maximize2,
  Minimize2,
  MoveHorizontal,
  RectangleHorizontal,
  RotateCcw,
  RotateCw,
  Rows3,
  Settings2,
  TableCellsMerge,
  TableCellsSplit,
  WrapText,
} from "lucide-react";
import type { ReactNode } from "react";
import type { EditorCommandBus } from "../../app/command-bus";
import { clampImageWidth, rotateImagePreservingSize } from "../image/image-transform";
import {
  canConvertInlineFigureToBlock,
  convertBlockFigureToInline,
  convertInlineFigureToBlock,
} from "../nodes/figure-commands";
import type { TableCommand } from "../table/table-commands";

type Props = {
  editor: Editor;
  editorId: string;
  commandBus: EditorCommandBus;
  execute(action: () => unknown): void;
  onProperties?: (() => void) | undefined;
};

function DeleteTableAxisIcon({ column = false }: { column?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <path d={column ? "M8 3v14M12 3v14" : "M3 8h14M3 12h14"} />
      <path d="m18 18 4 4m0-4-4 4" />
    </svg>
  );
}

/** The object counterpart of the text mini toolbar, using the same selection-safe executor. */
export function EditorObjectTools({ editor, editorId, commandBus, execute, onProperties }: Props) {
  const button = (
    label: string,
    icon: ReactNode,
    action: () => unknown,
    disabled = false,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={!editor.isEditable || disabled}
      className={label.startsWith("删除") ? "is-danger" : undefined}
      onClick={() => execute(action)}
    >
      {icon}
    </button>
  );
  const divider = <span className="editor-mini-divider" aria-hidden="true" />;
  const figure = commandBus.getFigureSelection(editorId);
  // An inline image inside a table is still an image target, not a cell target.
  if (figure.kind === "figure") {
    const update = (attributes: Record<string, unknown>) =>
      editor
        .chain()
        .updateAttributes(figure.nodeType, attributes)
        .setNodeSelection(figure.position)
        .run();
    const ratio = Number(editor.state.doc.nodeAt(figure.position)?.attrs.sourceAspectRatio ?? 1);
    const leftRotation = rotateImagePreservingSize(figure, ratio, "left");
    const rightRotation = rotateImagePreservingSize(figure, ratio, "right");
    return (
      <div className="editor-mini-format editor-object-tools" role="toolbar" aria-label="图片工具">
        <div className="editor-mini-row">
          {button(
            "图片左对齐",
            <AlignLeft />,
            () => update({ alignment: "left" }),
            figure.nodeType === "inlineFigure",
            figure.alignment === "left",
          )}
          {button(
            "图片居中",
            <AlignCenter />,
            () => update({ alignment: "center" }),
            figure.nodeType === "inlineFigure",
            figure.alignment === "center",
          )}
          {button(
            "图片右对齐",
            <AlignRight />,
            () => update({ alignment: "right" }),
            figure.nodeType === "inlineFigure",
            figure.alignment === "right",
          )}
          {divider}
          {button(
            "向左旋转90°",
            <RotateCcw />,
            () => leftRotation && update(leftRotation),
            !leftRotation,
          )}
          {button(
            "向右旋转90°",
            <RotateCw />,
            () => rightRotation && update(rightRotation),
            !rightRotation,
          )}
        </div>
        <div className="editor-mini-row">
          {button(
            "缩小图片",
            <Minimize2 />,
            () => update({ widthMm: clampImageWidth(figure.widthMm - 10) }),
            figure.widthMm <= 10,
          )}
          {button(
            "放大图片",
            <Maximize2 />,
            () => update({ widthMm: clampImageWidth(figure.widthMm + 10) }),
            figure.widthMm >= 165,
          )}
          {divider}
          {button(
            "独立成行",
            <RectangleHorizontal />,
            () => figure.nodeType === "figure" || convertInlineFigureToBlock(editor),
            figure.nodeType === "inlineFigure" && !canConvertInlineFigureToBlock(editor),
            figure.nodeType === "figure",
          )}
          {button(
            "嵌入型",
            <WrapText />,
            () => figure.nodeType === "inlineFigure" || convertBlockFigureToInline(editor),
            false,
            figure.nodeType === "inlineFigure",
          )}
          {divider}
          {button("图片设置", <Settings2 />, () => onProperties?.(), !onProperties)}
        </div>
      </div>
    );
  }

  const table = commandBus.getTableSelection(editorId);
  if (table.kind === "none") return null;
  const tableButton = (label: string, icon: ReactNode, command: TableCommand, disabled = false) =>
    button(label, icon, () => commandBus.runTableCommand(editorId, command), disabled);
  return (
    <div className="editor-mini-format editor-object-tools" role="toolbar" aria-label="表格工具">
      <div className="editor-mini-row">
        {tableButton(
          "上方插入行",
          <BetweenHorizontalStart />,
          "add-row-before",
          !table.canAddRowBefore,
        )}
        {tableButton("下方插入行", <BetweenHorizontalEnd />, "add-row-after")}
        {tableButton("左侧插入列", <BetweenVerticalStart />, "add-column-before")}
        {tableButton("右侧插入列", <BetweenVerticalEnd />, "add-column-after")}
        {divider}
        {tableButton("合并单元格", <TableCellsMerge />, "merge-cells", !table.canMerge)}
        {tableButton("拆分单元格", <TableCellsSplit />, "split-cell", !table.canSplit)}
        {button("表格属性", <Settings2 />, () => onProperties?.(), !onProperties)}
      </div>
      <div className="editor-mini-row">
        {button(
          "单元格左对齐",
          <AlignLeft />,
          () => commandBus.setTableCellAttribute(editorId, "horizontalAlignment", "left"),
          false,
          table.horizontalAlignment === "left",
        )}
        {button(
          "单元格居中",
          <AlignCenter />,
          () => commandBus.setTableCellAttribute(editorId, "horizontalAlignment", "center"),
          false,
          table.horizontalAlignment === "center",
        )}
        {button(
          "单元格右对齐",
          <AlignRight />,
          () => commandBus.setTableCellAttribute(editorId, "horizontalAlignment", "right"),
          false,
          table.horizontalAlignment === "right",
        )}
        {divider}
        {tableButton("适配正文宽度", <MoveHorizontal />, "fit-page")}
        {tableButton("平均分布列宽", <Columns3 />, "distribute-columns", table.columnCount < 2)}
        {tableButton("平均分布行高", <Rows3 />, "distribute-rows", table.rowCount < 2)}
        {divider}
        {tableButton("删除行", <DeleteTableAxisIcon />, "delete-row", !table.canDeleteRow)}
        {tableButton(
          "删除列",
          <DeleteTableAxisIcon column />,
          "delete-column",
          !table.canDeleteColumn,
        )}
      </div>
    </div>
  );
}

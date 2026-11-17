import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Captions,
  Rows3,
  TableCellsMerge,
  TableCellsSplit,
  Text,
  Trash2,
} from "lucide-react";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { EditorCommandBus } from "../../app/command-bus";
import { showAppAlert } from "../../shared/app-dialog";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import { TransientFunctionRailSlot } from "../../shared/transient-function-rail-slot";
import type { Mixed, TableSelectionSnapshot } from "./table-selection";

type TableRailPanelProps = {
  editorId: string;
  commandBus: EditorCommandBus;
};

function preserveEditorSelection(event: ReactPointerEvent<HTMLElement>): void {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
}

function isSelected<T extends string>(value: Mixed<T>, expected: T): boolean {
  return value === expected;
}

function selectionTargetChanged(
  previous: TableSelectionSnapshot,
  next: TableSelectionSnapshot,
): boolean {
  return (
    previous.tableFrom !== next.tableFrom ||
    previous.kind !== next.kind ||
    previous.selectedRowIndexes.join(",") !== next.selectedRowIndexes.join(",") ||
    previous.selectedColumnIndexes.join(",") !== next.selectedColumnIndexes.join(",")
  );
}

function selectionSummary(selection: TableSelectionSnapshot): string {
  if (selection.kind === "table")
    return `已选择整张表格，共 ${selection.rowCount} 行 ${selection.columnCount} 列`;
  if (selection.kind === "row")
    return `已选择 ${selection.rowCount} 行，共 ${selection.columnCount} 列`;
  if (selection.kind === "column")
    return `已选择 ${selection.columnCount} 列，共 ${selection.rowCount} 行`;
  if (selection.kind === "cell" || selection.kind === "text") return "当前单元格";
  return `已选择 ${selection.rowCount} 行 × ${selection.columnCount} 列`;
}

function TableRailButton({
  label,
  icon,
  displayLabel,
  pressed,
  disabled,
  disabledReason,
  danger,
  onClick,
  onPreview,
  hint,
}: {
  label: string;
  icon?: ReactNode;
  displayLabel?: string;
  pressed?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  onClick(): void;
  onPreview?(active: boolean): void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      className={`table-rail-panel__button${icon && !displayLabel ? " table-rail-panel__button--icon" : ""}${icon && displayLabel ? " table-rail-panel__button--labeled-icon" : ""}${pressed ? " is-active" : ""}${danger ? " is-danger" : ""}`}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      data-unavailable={disabled ? "true" : undefined}
      title={disabled ? disabledReason : (hint ?? label)}
      onMouseEnter={() => {
        if (!disabled) onPreview?.(true);
      }}
      onMouseLeave={() => onPreview?.(false)}
      onFocus={() => {
        if (!disabled) onPreview?.(true);
      }}
      onBlur={() => onPreview?.(false)}
      onClick={() => {
        if (disabled) {
          showAppAlert(disabledReason ?? `${label}当前不可用。`);
          return;
        }
        onClick();
      }}
    >
      {icon}
      {displayLabel ?? (!icon ? label : null)}
    </button>
  );
}

function TableRailGroup({
  label,
  ariaLabel = label,
  children,
}: {
  label: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="table-rail-panel__group" aria-label={ariaLabel}>
      <div className="table-rail-panel__group-content">{children}</div>
    </section>
  );
}

export function TableRailPanel({ editorId, commandBus }: TableRailPanelProps) {
  const [selection, setSelection] = useState<TableSelectionSnapshot>(() =>
    commandBus.getTableSelection(editorId),
  );
  const [dimensionError, setDimensionError] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitRows, setSplitRows] = useState("1");
  const [splitColumns, setSplitColumns] = useState("2");
  const [splitError, setSplitError] = useState<string | null>(null);
  const selectionRef = useRef(selection);

  useEffect(() => {
    const initial = commandBus.getTableSelection(editorId);
    selectionRef.current = initial;
    setSelection(initial);
    setSplitOpen(false);
    return commandBus.subscribeTableSelection(editorId, (next) => {
      if (selectionTargetChanged(selectionRef.current, next)) {
        setSplitOpen(false);
        setDimensionError(null);
      }
      selectionRef.current = next;
      setSelection(next);
    });
  }, [commandBus, editorId]);

  if (selection.kind === "none") {
    return <TransientFunctionRailSlot open={false}>{null}</TransientFunctionRailSlot>;
  }

  return (
    <TransientFunctionRailSlot open>
      <section
        className="table-rail-panel function-rail-transient-panel"
        aria-label="表格功能"
        onPointerDown={preserveEditorSelection}
      >
        <p className="table-rail-panel__summary" aria-live="polite">
          {selectionSummary(selection)}
        </p>

        {dimensionError ? <p role="alert">{dimensionError}</p> : null}
        {selection.overflowsPage ? (
          <p role="status">
            表格超出正文宽度。
            <button
              className="table-rail-panel__button"
              type="button"
              onClick={() => {
                if (!commandBus.runTableCommand(editorId, "fit-page"))
                  setDimensionError("列数或留白过大，无法适配；请减少列数或拆成多张表。");
              }}
            >
              适配正文宽度
            </button>
          </p>
        ) : null}
        <TableRailGroup label="结构" ariaLabel="表格结构">
          <fieldset className="table-rail-panel__operation" aria-label="行操作">
            <legend className="table-rail-panel__operation-label">行</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--operation">
              <TableRailButton
                label="上方插入行"
                displayLabel="上方"
                icon={<BetweenHorizontalStart aria-hidden="true" />}
                onPreview={(active) =>
                  commandBus.previewTableInsertion(editorId, active ? "add-row-before" : null)
                }
                disabled={!selection.canAddRowBefore}
                disabledReason="标题行必须位于表格第一行，不能在其上方插入新行。"
                onClick={() => commandBus.runTableCommand(editorId, "add-row-before")}
              />
              <TableRailButton
                label="下方插入行"
                displayLabel="下方"
                icon={<BetweenHorizontalEnd aria-hidden="true" />}
                onPreview={(active) =>
                  commandBus.previewTableInsertion(editorId, active ? "add-row-after" : null)
                }
                onClick={() => commandBus.runTableCommand(editorId, "add-row-after")}
              />
              <TableRailButton
                label="删除行"
                displayLabel="删除行"
                icon={<Trash2 aria-hidden="true" />}
                disabled={!selection.canDeleteRow}
                disabledReason="选区覆盖全部行。若要移除整张表，请使用“删除表格”。"
                danger
                onClick={() => commandBus.runTableCommand(editorId, "delete-row")}
              />
            </div>
          </fieldset>
          <fieldset className="table-rail-panel__operation" aria-label="列操作">
            <legend className="table-rail-panel__operation-label">列</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--operation">
              <TableRailButton
                label="左侧插入列"
                displayLabel="左侧"
                icon={<BetweenVerticalStart aria-hidden="true" />}
                onPreview={(active) =>
                  commandBus.previewTableInsertion(editorId, active ? "add-column-before" : null)
                }
                onClick={() => commandBus.runTableCommand(editorId, "add-column-before")}
              />
              <TableRailButton
                label="右侧插入列"
                displayLabel="右侧"
                icon={<BetweenVerticalEnd aria-hidden="true" />}
                onPreview={(active) =>
                  commandBus.previewTableInsertion(editorId, active ? "add-column-after" : null)
                }
                onClick={() => commandBus.runTableCommand(editorId, "add-column-after")}
              />
              <TableRailButton
                label="删除列"
                displayLabel="删除列"
                icon={<Trash2 aria-hidden="true" />}
                disabled={!selection.canDeleteColumn}
                disabledReason="选区覆盖全部列。若要移除整张表，请使用“删除表格”。"
                danger
                onClick={() => commandBus.runTableCommand(editorId, "delete-column")}
              />
            </div>
          </fieldset>
          <fieldset className="table-rail-panel__operation" aria-label="单元格操作">
            <legend className="table-rail-panel__operation-label">单元格</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--operation table-rail-panel__buttons--cell">
              <TableRailButton
                label="合并单元格"
                displayLabel="合并"
                icon={<TableCellsMerge aria-hidden="true" />}
                disabled={!selection.canMerge}
                disabledReason="请先选择两个或以上可合并的单元格。"
                onClick={() => commandBus.runTableCommand(editorId, "merge-cells")}
              />
              <TableRailButton
                label="拆分单元格"
                displayLabel="拆分"
                icon={<TableCellsSplit aria-hidden="true" />}
                disabled={selection.selectedCellCount !== 1}
                disabledReason="请将光标放入一个单元格，或只选择一个单元格。"
                onClick={() => {
                  setSplitRows(String(selection.rowCount));
                  setSplitColumns(String(Math.max(2, selection.columnCount)));
                  setSplitError(null);
                  setSplitOpen(true);
                }}
              />
            </div>
          </fieldset>
          <fieldset className="table-rail-panel__alignment-row" aria-label="水平位置">
            <legend className="table-rail-panel__alignment-label">水平位置</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--alignment">
              {(["left", "center", "right"] as const).map((value) => (
                <TableRailButton
                  key={value}
                  label={{ left: "左对齐", center: "居中", right: "右对齐" }[value]}
                  icon={
                    {
                      left: <AlignLeft aria-hidden="true" />,
                      center: <AlignCenter aria-hidden="true" />,
                      right: <AlignRight aria-hidden="true" />,
                    }[value]
                  }
                  pressed={isSelected(selection.horizontalAlignment, value)}
                  onClick={() =>
                    commandBus.setTableCellAttribute(editorId, "horizontalAlignment", value)
                  }
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="table-rail-panel__alignment-row" aria-label="垂直位置">
            <legend className="table-rail-panel__alignment-label">垂直位置</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--alignment">
              {(["top", "middle", "bottom"] as const).map((value) => (
                <TableRailButton
                  key={value}
                  label={{ top: "顶部对齐", middle: "垂直居中", bottom: "底部对齐" }[value]}
                  icon={
                    {
                      top: <AlignVerticalJustifyStart aria-hidden="true" />,
                      middle: <AlignVerticalJustifyCenter aria-hidden="true" />,
                      bottom: <AlignVerticalJustifyEnd aria-hidden="true" />,
                    }[value]
                  }
                  pressed={isSelected(selection.verticalAlignment, value)}
                  onClick={() =>
                    commandBus.setTableCellAttribute(editorId, "verticalAlignment", value)
                  }
                />
              ))}
            </div>
          </fieldset>
          {selection.horizontalAlignment === "mixed" || selection.verticalAlignment === "mixed" ? (
            <span className="table-rail-panel__mixed">多种</span>
          ) : null}
          <fieldset className="table-rail-panel__alignment-row" aria-label="表格位置">
            <legend className="table-rail-panel__alignment-label">表格位置</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--alignment">
              {(["left", "center", "right"] as const).map((value) => (
                <TableRailButton
                  key={value}
                  label={{ left: "表格靠左", center: "表格居中", right: "表格靠右" }[value]}
                  displayLabel={{ left: "靠左", center: "居中", right: "靠右" }[value]}
                  icon={
                    {
                      left: <AlignHorizontalJustifyStart aria-hidden="true" />,
                      center: <AlignHorizontalJustifyCenter aria-hidden="true" />,
                      right: <AlignHorizontalJustifyEnd aria-hidden="true" />,
                    }[value]
                  }
                  pressed={(selection.tableAlignment ?? "left") === value}
                  onClick={() => commandBus.runTableCommand(editorId, `align-table-${value}`)}
                />
              ))}
            </div>
          </fieldset>
          <SpatialCollapse open={Boolean(splitOpen)}>
            {
              <fieldset
                aria-label="拆分单元格设置"
                style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}
              >
                <div
                  className="table-rail-panel__dimension-row"
                  style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
                >
                  <label className="table-rail-panel__dimension-field">
                    <span>行数</span>
                    <input
                      aria-label="拆分行数"
                      type="number"
                      min="1"
                      max="100"
                      value={splitRows}
                      onChange={(event) => setSplitRows(event.target.value)}
                    />
                  </label>
                  <label className="table-rail-panel__dimension-field">
                    <span>列数</span>
                    <input
                      aria-label="拆分列数"
                      type="number"
                      min="1"
                      max="30"
                      value={splitColumns}
                      onChange={(event) => setSplitColumns(event.target.value)}
                    />
                  </label>
                </div>
                {selection.canSplit ? (
                  <TableRailButton
                    label="还原合并"
                    onClick={() => {
                      if (commandBus.runTableCommand(editorId, "split-cell")) setSplitOpen(false);
                    }}
                  />
                ) : null}
                <p>原内容保留在左上单元格。</p>
                {splitError ? <span role="alert">{splitError}</span> : null}
                <div className="table-rail-panel__buttons">
                  <TableRailButton
                    label="应用拆分"
                    onClick={() => {
                      const rows = Number(splitRows),
                        columns = Number(splitColumns);
                      if (
                        !Number.isInteger(rows) ||
                        !Number.isInteger(columns) ||
                        rows < 1 ||
                        rows > 100 ||
                        columns < 1 ||
                        columns > 30 ||
                        rows * columns < 2
                      ) {
                        setSplitError("行数为 1–100，列数为 1–30，至少拆成两个单元格。");
                        return;
                      }
                      if (commandBus.splitTableCell(editorId, { rows, columns }))
                        setSplitOpen(false);
                      else
                        setSplitError("无法拆分：请重新选择单个单元格；空间不足时请减少行列数。");
                    }}
                  />
                  <TableRailButton label="取消拆分" onClick={() => setSplitOpen(false)} />
                </div>
              </fieldset>
            }
          </SpatialCollapse>
        </TableRailGroup>

        <TableRailGroup label="表格宽度">
          <fieldset className="table-rail-panel__operation" aria-label="宽度操作">
            <legend className="table-rail-panel__operation-label">表格宽度</legend>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--operation table-rail-panel__buttons--cell">
              <TableRailButton
                label="适应页面"
                displayLabel="适应页面"
                icon={<BetweenHorizontalStart aria-hidden="true" />}
                onClick={() => {
                  if (!commandBus.runTableCommand(editorId, "fit-page"))
                    showAppAlert(
                      "无法适应页面，请减少列数或检查单元格中的大尺寸图片。原内容未改变。",
                    );
                }}
              />
              <TableRailButton
                label="最小宽度"
                displayLabel="最小宽度"
                icon={<BetweenHorizontalEnd aria-hidden="true" />}
                onClick={() => {
                  if (!commandBus.runTableCommand(editorId, "auto-fit-content"))
                    showAppAlert("无法收紧表格，请检查列数或单元格中的大尺寸图片。原内容未改变。");
                }}
              />
            </div>
            <div className="table-rail-panel__buttons table-rail-panel__buttons--operation table-rail-panel__buttons--single">
              <TableRailButton
                label="自动整理"
                displayLabel="自动整理"
                icon={<Rows3 aria-hidden="true" />}
                onClick={() => {
                  if (!commandBus.runTableCommand(editorId, "auto-arrange"))
                    showAppAlert("无法自动整理，请检查列数或单元格中的大尺寸图片。原内容未改变。");
                }}
              />
            </div>
          </fieldset>
        </TableRailGroup>

        <TableRailGroup label="内容" ariaLabel="表格内容">
          <div className="table-rail-panel__buttons table-rail-panel__buttons--operation table-rail-panel__buttons--single">
            <TableRailButton
              label="将首行设为标题行"
              displayLabel="将首行设为标题行"
              icon={<Rows3 aria-hidden="true" />}
              pressed={selection.firstRowHeader === true}
              onClick={() => commandBus.runTableCommand(editorId, "toggle-header-row")}
            />
          </div>
          <div className="table-rail-panel__buttons table-rail-panel__buttons--operation table-rail-panel__buttons--cell">
            <TableRailButton
              label="表名"
              displayLabel="表名"
              icon={<Captions aria-hidden="true" />}
              hint={selection.tableNameEnabled ? "隐藏表名（保留内容）" : "显示表名"}
              pressed={selection.tableNameEnabled === true}
              onClick={() =>
                commandBus.setTableAnnotation(editorId, {
                  tableNameEnabled: !selection.tableNameEnabled,
                })
              }
            />
            <TableRailButton
              label="补充说明"
              displayLabel="补充说明"
              icon={<Text aria-hidden="true" />}
              hint={selection.tableNoteEnabled ? "隐藏补充说明（保留内容）" : "显示补充说明"}
              pressed={selection.tableNoteEnabled === true}
              onClick={() =>
                commandBus.setTableAnnotation(editorId, {
                  tableNoteEnabled: !selection.tableNoteEnabled,
                })
              }
            />
          </div>
          {selection.tableNameEnabled ? (
            <label className="table-rail-panel__dimension-field table-rail-panel__annotation-field">
              <span>表名</span>
              <textarea
                aria-label="表名内容"
                rows={1}
                maxLength={2000}
                value={selection.tableName ?? ""}
                onChange={(event) =>
                  commandBus.setTableAnnotation(editorId, { tableName: event.target.value })
                }
              />
            </label>
          ) : null}
          {selection.tableNoteEnabled ? (
            <label className="table-rail-panel__dimension-field table-rail-panel__annotation-field">
              <span>补充说明</span>
              <textarea
                aria-label="补充说明内容"
                rows={1}
                maxLength={10000}
                value={selection.tableNote ?? ""}
                onChange={(event) =>
                  commandBus.setTableAnnotation(editorId, { tableNote: event.target.value })
                }
              />
            </label>
          ) : null}
        </TableRailGroup>
      </section>
    </TransientFunctionRailSlot>
  );
}

import { AlertTriangle, CheckCircle2, FileText, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type {
  BlockNode,
  InlineNode,
  ParagraphAttributes,
  TextMark,
} from "../../../shared/document/model";
import type {
  DocxImportCommitRequest,
  DocxImportPreview,
  DocxImportTarget,
  DocxImportUpdateRequest,
} from "../../../shared/ipc/contract";
import { descriptionInventionTitle } from "../../../shared/patent/description";
import { useMotionPresenceClosing } from "../app/motion-presence";
import { SpatialPresence } from "../shared/spatial-presence";
import { useModalDialog } from "../shared/use-modal-dialog";
import { useSpatialViewMotion } from "../shared/use-spatial-view-motion";
import { AssetPreview } from "./editors/asset-preview";

type DocxImportDialogProps = {
  preview: DocxImportPreview;
  busy: boolean;
  onUpdate(request: DocxImportUpdateRequest): Promise<void>;
  onCancel(): Promise<void>;
  onCommit(request: DocxImportCommitRequest): Promise<void>;
};

export function DocxImportDialog({ preview, busy, onCancel, onCommit }: DocxImportDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closing = useMotionPresenceClosing();
  const previewStage = useRef<HTMLDivElement>(null);
  const [selectedUnitId, setSelectedUnitId] = useState(preview.units[0]?.unitId ?? "");
  useSpatialViewMotion(previewStage, selectedUnitId);
  const [patentName, setPatentName] = useState(() => {
    const description = preview.units.find(
      (unit) => unit.target.kind === "official-book" && unit.target.bookKind === "description",
    );
    return description ? (descriptionInventionTitle(description.document) ?? "") : "";
  });
  const [customer, setCustomer] = useState("");
  const [patentType, setPatentType] = useState<"invention" | "utility-model">("invention");
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());
  const [drawingOrders, setDrawingOrders] = useState<Record<string, string[]>>({});
  const [commitPending, setCommitPending] = useState(false);
  const [slowCommit, setSlowCommit] = useState(false);
  const commitPendingRef = useRef(false);
  useModalDialog({
    open: !closing,
    containerRef: dialogRef,
    onClose: () => {
      if (!busy && !commitPendingRef.current) void onCancel();
    },
  });
  const selected =
    preview.units.find((unit) => unit.unitId === selectedUnitId) ?? preview.units[0] ?? null;
  const importantWarnings = preview.warnings.filter((warning) => warning.severity === "important");
  const duplicateTargets = duplicateOfficialTargets(preview.units.map((unit) => unit.target));
  const blockerReason =
    duplicateTargets.length > 0
      ? "五书类型重复，请取消并重新选择文件。"
      : importantWarnings.some((warning) => !acknowledged.has(warning.warningId))
        ? "请先确认所有重要导入提示。"
        : null;
  const ready = blockerReason === null;

  useEffect(() => {
    if (selected && !preview.units.some((unit) => unit.unitId === selectedUnitId)) {
      setSelectedUnitId(selected.unitId);
    }
  }, [preview.units, selected, selectedUnitId]);
  useEffect(() => {
    if (!commitPending && !busy) {
      setSlowCommit(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowCommit(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [busy, commitPending]);

  const selectedFigureIds = useMemo(
    () => (selected ? figureAssetIds(selected.document.content) : []),
    [selected],
  );
  useEffect(() => {
    if (!selected || selectedFigureIds.length === 0 || drawingOrders[selected.unitId]) return;
    setDrawingOrders((current) => ({ ...current, [selected.unitId]: selectedFigureIds }));
  }, [drawingOrders, selected, selectedFigureIds]);

  const commit = async () => {
    if (commitPendingRef.current) return;
    commitPendingRef.current = true;
    setCommitPending(true);
    try {
      await onCommit({
        sessionId: preview.sessionId,
        patentType,
        name: patentName.trim() || null,
        customer: customer.trim() || null,
        assignments: preview.units.map((unit) => ({
          unitId: unit.unitId,
          title: unit.title,
          target: unit.target,
          ...(drawingOrders[unit.unitId] ? { drawingOrder: drawingOrders[unit.unitId] } : {}),
        })),
        acknowledgedWarningIds: [...acknowledged],
      });
    } finally {
      commitPendingRef.current = false;
      setCommitPending(false);
    }
  };

  return (
    <div className="docx-import-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="docx-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入docx"
      >
        <header className="docx-import-dialog__header">
          <div>
            <span className="docx-import-dialog__eyebrow">DOCX 导入预览</span>
            <h2>确认导入内容</h2>
            <p>已识别为五书文档，确认后创建专利。</p>
          </div>
          <button
            type="button"
            className="docx-import-dialog__close"
            aria-label="取消导入"
            disabled={busy || commitPending}
            onClick={() => void onCancel()}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {
          <div className="docx-import-dialog__metadata">
            <label>
              专利名称
              <input
                value={patentName}
                placeholder="可稍后填写"
                onChange={(event) => setPatentName(event.currentTarget.value)}
              />
            </label>
            <label>
              客户
              <input
                value={customer}
                placeholder="可选"
                onChange={(event) => setCustomer(event.currentTarget.value)}
              />
            </label>
            <label>
              专利类型
              <select
                value={patentType}
                onChange={(event) => setPatentType(event.currentTarget.value as typeof patentType)}
              >
                <option value="invention">发明专利</option>
                <option value="utility-model">实用新型</option>
              </select>
            </label>
          </div>
        }

        <div className="docx-import-dialog__columns">
          <aside className="docx-import-sources" aria-label="来源文件与内容">
            <h3>文件与内容</h3>
            {preview.sourceFileNames.map((fileName) => (
              <div className="docx-import-source" key={fileName}>
                <strong>
                  <FileText size={16} aria-hidden="true" />
                  {fileName}
                </strong>
                {preview.units
                  .filter((unit) => unit.sourceFileName === fileName)
                  .map((unit) => (
                    <button
                      key={unit.unitId}
                      type="button"
                      className={unit.unitId === selected?.unitId ? "is-active" : ""}
                      onClick={() => setSelectedUnitId(unit.unitId)}
                    >
                      <span>{unit.title}</span>
                      <small>{confidenceLabel(unit.confidence)}</small>
                    </button>
                  ))}
              </div>
            ))}
          </aside>

          <main className="docx-import-preview" aria-label="文档内容预览">
            <div className="docx-import-preview__paper">
              <h3>{selected?.title}</h3>
              <SpatialPresence>
                {selected ? (
                  <div ref={previewStage}>
                    <DocumentBlocks
                      sessionId={preview.sessionId}
                      blocks={selected.document.content}
                    />
                  </div>
                ) : null}
              </SpatialPresence>
            </div>
          </main>

          <aside className="docx-import-settings" aria-label="导入设置">
            <h3>导入设置</h3>
            {selected ? (
              <div className="docx-import-confidence">
                <CheckCircle2 size={16} aria-hidden="true" />
                <div>
                  <strong>{selected.title}</strong>
                  <p>{selected.evidence.join("；")}</p>
                </div>
              </div>
            ) : null}
            <SpatialPresence>
              {duplicateTargets.length > 0 ? (
                <div className="docx-import-conflict">
                  <AlertTriangle size={17} />
                  五书类型重复，请取消并重新选择文件。
                </div>
              ) : null}
            </SpatialPresence>
            <SpatialPresence>
              {preview.warnings.length > 0 ? (
                <section className="docx-import-warnings">
                  <h4>导入提示</h4>
                  {preview.warnings.map((warning) => (
                    <label
                      key={warning.warningId}
                      className={warning.severity === "important" ? "is-important" : ""}
                    >
                      <input
                        type="checkbox"
                        disabled={warning.severity !== "important"}
                        checked={
                          warning.severity !== "important" || acknowledged.has(warning.warningId)
                        }
                        aria-label={warning.message}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setAcknowledged((current) => {
                            const next = new Set(current);
                            if (checked) next.add(warning.warningId);
                            else next.delete(warning.warningId);
                            return next;
                          });
                        }}
                      />
                      <span>{warning.message}</span>
                    </label>
                  ))}
                </section>
              ) : null}
            </SpatialPresence>
          </aside>
        </div>

        <footer className="docx-import-dialog__footer">
          <div className="docx-import-dialog__footer-copy">
            <p>原 DOCX 不会保存在软件中，请自行保留源文件。</p>
            {blockerReason ? <p role="status">{blockerReason}</p> : null}
            {slowCommit ? <p role="status">导入耗时较长，仍在处理中，请勿重复操作。</p> : null}
          </div>
          <div>
            <button type="button" disabled={busy || commitPending} onClick={() => void onCancel()}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || commitPending || !ready}
              onClick={() => void commit()}
            >
              {busy ? "正在导入…" : commitPending ? "正在准备导入…" : "创建并导入"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function DocumentBlocks({
  sessionId,
  blocks,
}: {
  sessionId: string;
  blocks: readonly BlockNode[];
}) {
  return (
    <>
      {blocks.map((block) => (
        <BlockPreview key={block.id} sessionId={sessionId} block={block} />
      ))}
    </>
  );
}

function BlockPreview({ sessionId, block }: { sessionId: string; block: BlockNode }) {
  if (block.type === "paragraph")
    return <p style={paragraphStyle(block.attrs)}>{renderInlineContent(block.content)}</p>;
  if (block.type === "heading")
    return <h4 style={paragraphStyle(block.attrs)}>{renderInlineContent(block.content)}</h4>;
  if (block.type === "page-break") return <hr />;
  if (block.type === "figure") {
    const getPreview = window.patentApi.patents.getDocxImportPreviewAsset;
    return (
      <div className="docx-import-preview__figure">
        {getPreview ? (
          <AssetPreview
            sessionId={sessionId}
            assetId={block.assetId}
            alt="导入图片预览"
            getPreview={getPreview}
          />
        ) : (
          <span role="status">图片预览不可用</span>
        )}
      </div>
    );
  }
  if (block.type === "block-formula")
    return <p className="docx-import-preview__formula">{block.source}</p>;
  if (block.type === "chemical-structure") return <div>化学结构式</div>;
  if (block.type === "table")
    return (
      <table>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell) => (
                <td key={cell.id}>
                  {cell.content.map((paragraph) => (
                    <p key={paragraph.id} style={paragraphStyle(paragraph.attrs)}>
                      {renderInlineContent(paragraph.content)}
                    </p>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  const ordered = block.type === "ordered-list";
  const List = ordered ? "ol" : "ul";
  return (
    <List>
      {block.items.map((item) => (
        <li key={item.id}>
          {item.content.map((paragraph) => (
            <p key={paragraph.id} style={paragraphStyle(paragraph.attrs)}>
              {renderInlineContent(paragraph.content)}
            </p>
          ))}
        </li>
      ))}
    </List>
  );
}

function paragraphStyle(attributes: ParagraphAttributes): CSSProperties {
  return {
    textAlign: attributes.alignment,
    textIndent: `${attributes.paragraphIndentMm}mm`,
    lineHeight: attributes.lineSpacing,
    fontFamily: attributes.defaultFontFamily,
    fontSize: `${attributes.defaultFontSizePt}pt`,
  };
}

function renderInlineContent(content: readonly InlineNode[]): ReactNode[] {
  return content.map((inline, index) => {
    const key = `${inline.type}-${index}`;
    if (inline.type === "hard-break") return <br key={key} />;
    if (inline.type === "inline-formula") return <span key={key}>{inline.source}</span>;
    if (inline.type === "inline-figure") return <span key={key}>图片</span>;
    return (
      <span key={key} style={textMarkStyle(inline.marks)}>
        {inline.text}
      </span>
    );
  });
}

function textMarkStyle(marks: readonly TextMark[]): CSSProperties {
  const style: CSSProperties = {};
  for (const mark of marks) {
    if (mark.type === "bold") style.fontWeight = 700;
    else if (mark.type === "italic") style.fontStyle = "italic";
    else if (mark.type === "underline") style.textDecoration = "underline";
    else if (mark.type === "superscript") style.verticalAlign = "super";
    else if (mark.type === "subscript") style.verticalAlign = "sub";
    else if (mark.type === "font-family") style.fontFamily = mark.value;
    else if (mark.type === "font-size") style.fontSize = `${mark.valuePt}pt`;
    else if (mark.type === "color") style.color = mark.value;
    else if (mark.type === "background-color") style.backgroundColor = mark.value;
  }
  return style;
}

function duplicateOfficialTargets(targets: readonly DocxImportTarget[]): string[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    if (target.kind !== "official-book") continue;
    counts.set(target.bookKind, (counts.get(target.bookKind) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([bookKind]) => bookKind);
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "识别明确" : confidence === "medium" ? "建议检查" : "需要确认";
}

function figureAssetIds(blocks: readonly BlockNode[]): string[] {
  return blocks.flatMap((block) => (block.type === "figure" ? [block.assetId] : []));
}

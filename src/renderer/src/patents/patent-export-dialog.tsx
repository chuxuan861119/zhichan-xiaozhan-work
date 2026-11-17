import { useState } from "react";
import { PATENT_BOOK_LABELS, type PatentBookKind } from "../../../shared/patent/model";
import { StandardDialog } from "../shared/standard-dialog";

export type PatentExportMode = "combined" | "single";
export type PatentExportFormat = "docx" | "pdf" | "patdoc";

type PatentExportDialogProps = {
  format: PatentExportFormat;
  bookKind: PatentBookKind;
  suggestedName: string;
  onExport(format: PatentExportFormat, mode: PatentExportMode, suggestedName: string): void;
  onCancel(): void;
};

export function PatentExportDialog({
  format,
  bookKind,
  suggestedName,
  onExport,
  onCancel,
}: PatentExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<PatentExportFormat>(format);
  const [mode, setMode] = useState<PatentExportMode>("combined");
  const [fileName, setFileName] = useState(suggestedName);
  const patdoc = selectedFormat === "patdoc";
  const effectiveMode = patdoc ? "combined" : mode;
  const bookLabel = PATENT_BOOK_LABELS[bookKind];
  const trimmedFileName = fileName.trim();

  return (
    <StandardDialog
      open
      title="导出专利文档"
      subtitle="选择文件格式与导出范围"
      size="m"
      onCancel={onCancel}
      className="patent-export-dialog"
      bodyClassName="patent-export-dialog__body"
      footer={
        <>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={trimmedFileName.length === 0}
            onClick={() => onExport(selectedFormat, effectiveMode, trimmedFileName)}
          >
            导出
          </button>
        </>
      }
    >
      <div className="patent-export-dialog__form">
        <label htmlFor="patent-export-format">文件格式</label>
        <select
          id="patent-export-format"
          value={selectedFormat}
          onChange={(event) => {
            const nextFormat = event.currentTarget.value as PatentExportFormat;
            setSelectedFormat(nextFormat);
            if (nextFormat === "patdoc" && mode === "single") {
              setMode("combined");
              setFileName(suggestedName);
            }
          }}
        >
          <option value="docx">Word 文档（.docx）</option>
          <option value="pdf">PDF 文档（.pdf）</option>
          <option value="patdoc">专利工作台文档（.patdoc）</option>
        </select>

        <label htmlFor="patent-export-mode">导出范围</label>
        <select
          id="patent-export-mode"
          value={effectiveMode}
          disabled={patdoc}
          onChange={(event) => {
            const nextMode = event.currentTarget.value as PatentExportMode;
            setMode(nextMode);
            setFileName(nextMode === "single" ? `${suggestedName}-${bookLabel}` : suggestedName);
          }}
        >
          <option value="combined">全部五书</option>
          <option value="single">当前书册（{bookLabel}）</option>
        </select>

        <label htmlFor="patent-export-file-name">文件名称</label>
        <input
          id="patent-export-file-name"
          type="text"
          value={fileName}
          maxLength={250}
          onChange={(event) => setFileName(event.currentTarget.value)}
        />
        <p className="patent-export-dialog__save-hint">
          点击导出后选择保存位置，文件扩展名自动添加。
        </p>

        {patdoc ? (
          <p className="patent-export-dialog__note">
            <span className="patent-export-dialog__note-icon" aria-hidden="true">
              ⓘ
            </span>
            PATDOC 将保留当前专利的全部书册、附图及可编辑数据。
          </p>
        ) : null}
      </div>
    </StandardDialog>
  );
}

type LibraryPatentExportDialogProps = {
  count?: number;
  availableBookKinds?: readonly PatentBookKind[];
  onExport(
    format: "patdoc" | "docx" | "pdf",
    mode: PatentExportMode,
    bookKind: PatentBookKind,
  ): void;
  onCancel(): void;
};

export function LibraryPatentExportDialog({
  count = 1,
  onExport,
  onCancel,
}: LibraryPatentExportDialogProps) {
  const [format, setFormat] = useState<"patdoc" | "docx" | "pdf">("docx");
  return (
    <StandardDialog
      open
      title="导出专利"
      subtitle={count > 1 ? `已选 ${count} 项 · 每项五书合一 · ZIP 压缩包` : "五书合一"}
      size="m"
      onCancel={onCancel}
      bodyClassName="patent-dialog-body"
      footer={
        <>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onExport(format, "combined", "claims")}
          >
            导出
          </button>
        </>
      }
    >
      <fieldset className="dialog-fieldset">
        <legend>导出格式</legend>
        {(["docx", "pdf", "patdoc"] as const).map((candidate) => (
          <label key={candidate}>
            <input
              type="radio"
              name="library-patent-export-format"
              checked={format === candidate}
              onChange={() => setFormat(candidate)}
            />
            {candidate.toUpperCase()}
          </label>
        ))}
      </fieldset>
      {count > 1 && format === "docx" ? (
        <p>包含五书原生还原数据，可重新导入本软件。文件未加密，请妥善保管。</p>
      ) : null}
      {format === "patdoc" ? <p>PATDOC 会保留当前专利的附图书状态。</p> : null}
      {count > 1 && format === "pdf" ? <p>PDF 压缩包仅供查看，不支持重新导入。</p> : null}
    </StandardDialog>
  );
}

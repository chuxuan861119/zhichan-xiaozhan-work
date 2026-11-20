import { useEffect, useRef, useState } from "react";
import type { AppError } from "../../../shared/ipc/result";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { canPermanentlyDeletePatent } from "../../../shared/library/trash-protection";
import { TRASH_RETENTION_MS } from "../../../shared/library/trash-retention";
import { patentDisplayName } from "../../../shared/patent/display-name";
import { PATENT_BOOK_LABELS, PATENT_BOOK_ORDER } from "../../../shared/patent/model";
import { useLibraryListMotion } from "./use-library-list-motion";

type TrashViewProps = {
  documents: LibraryDocumentSummary[];
  patents?: LibraryPatentSummary[];
  loading: boolean;
  error?: AppError | null;
  onRetry?(): void;
  onBackToLibrary(): void;
  onRestoreDocument(document: LibraryDocumentSummary): void;
  onPermanentlyDeleteDocument(document: LibraryDocumentSummary): void;
  onRestorePatent?(patent: LibraryPatentSummary): void;
  onPermanentlyDeletePatent?(patent: LibraryPatentSummary): void;
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN");
}

function purgeDate(item: { deletedAt: string | null }): string {
  if (!item.deletedAt) return "待确认";
  return formatDate(new Date(Date.parse(item.deletedAt) + TRASH_RETENTION_MS).toISOString());
}

const PATENT_TYPE_LABELS: Record<LibraryPatentSummary["patentType"], string> = {
  invention: "发明",
  "utility-model": "实用新型",
  design: "外观设计",
};

export function TrashView({
  documents,
  patents = [],
  loading,
  error = null,
  onRetry,
  onBackToLibrary,
  onRestoreDocument,
  onPermanentlyDeleteDocument,
  onRestorePatent,
  onPermanentlyDeletePatent,
}: TrashViewProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const listRef = useRef<HTMLElement | null>(null);
  const layoutKey = [
    ...patents.map((patent) => `patent:${patent.patentId}`),
    ...documents.map((document) => `document:${document.libraryDocumentId}`),
  ].join("|");
  const captureLayout = useLibraryListMotion(listRef, layoutKey);

  return (
    <main className="library-view" aria-label="回收站">
      <header className="library-header">
        <div>
          <h1>回收站</h1>
          <p>删除的专利或文档保留 1 年（365 天），过期后自动清理。</p>
          <p>专利移入回收站后，24 小时内不能永久删除，可随时恢复。</p>
        </div>
        <button type="button" onClick={onBackToLibrary}>
          返回专利库
        </button>
      </header>
      {loading ? <p className="library-empty">正在读取回收站…</p> : null}
      {error ? (
        <section className="library-read-error" role="alert">
          <div>
            <strong>回收站暂时无法读取</strong>
            <p>已保留上次成功读取的结果。{error.message}</p>
          </div>
          <button type="button" disabled={loading} onClick={onRetry}>
            重试读取回收站
          </button>
        </section>
      ) : null}
      {!loading && !error && documents.length === 0 && patents.length === 0 ? (
        <p className="library-empty">回收站为空。</p>
      ) : null}
      <section ref={listRef} className="library-list" aria-label="已删除内容">
        {patents.map((patent) => {
          const title = patentDisplayName(patent);
          return (
            <article
              className="library-card trash-card patent-card"
              aria-label={title}
              key={patent.patentId}
              data-library-item-key={`patent:${patent.patentId}`}
            >
              <div className="library-card-main">
                <h2>{title}</h2>
                <p className="library-card-meta">
                  {PATENT_TYPE_LABELS[patent.patentType]} · 删除时间：
                  {patent.deletedAt ? formatDate(patent.deletedAt) : "待确认"} · 1 年后自动清理：
                  {purgeDate(patent)}
                </p>
                <p className="library-card-snippet">
                  {patent.recoveryState === "quarantined"
                    ? "该专利已被保护性隔离，书册状态暂不可读取。"
                    : `包含${PATENT_BOOK_ORDER.filter(
                        (kind) => patent.bookStatuses[kind] !== "unavailable",
                      )
                        .map((kind) => PATENT_BOOK_LABELS[kind])
                        .join("、")}。`}
                </p>
              </div>
              <div className="library-card-actions">
                <button
                  type="button"
                  aria-label={`恢复 ${title}`}
                  onClick={() => {
                    captureLayout();
                    onRestorePatent?.(patent);
                  }}
                >
                  恢复
                </button>
                <button
                  className="danger-button"
                  type="button"
                  aria-label={`永久删除 ${title}`}
                  disabled={!canPermanentlyDeletePatent(patent.deletedAt, now)}
                  onClick={() => {
                    captureLayout();
                    onPermanentlyDeletePatent?.(patent);
                  }}
                >
                  永久删除
                </button>
              </div>
            </article>
          );
        })}
        {documents.map((document) => (
          <article
            className="library-card trash-card"
            aria-label={document.title}
            key={document.libraryDocumentId}
            data-library-item-key={`document:${document.libraryDocumentId}`}
          >
            <div className="library-card-main">
              <h2>{document.title}</h2>
              <p className="library-card-meta">
                删除时间：{document.deletedAt ? formatDate(document.deletedAt) : "待确认"} · 1
                年后自动清理：{purgeDate(document)}
              </p>
              <p className="library-card-snippet">{document.snippet || "暂无正文摘要。"}</p>
            </div>
            <div className="library-card-actions">
              <button
                type="button"
                aria-label={`恢复 ${document.title}`}
                onClick={() => {
                  captureLayout();
                  onRestoreDocument(document);
                }}
              >
                恢复
              </button>
              <button
                className="danger-button"
                type="button"
                aria-label={`永久删除 ${document.title}`}
                onClick={() => {
                  captureLayout();
                  onPermanentlyDeleteDocument(document);
                }}
              >
                永久删除
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

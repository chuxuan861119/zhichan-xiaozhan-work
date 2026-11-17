import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionPresence } from "../../../src/renderer/src/app/motion-presence";
import { TrashDialog } from "../../../src/renderer/src/library/trash-dialog";
import type {
  LibraryDocumentSummary,
  LibraryPatentSummary,
} from "../../../src/shared/library/model";
import "../../../src/renderer/src/app/app.css";
import "../../../src/renderer/src/shared/standard-dialog.css";

const now = Date.now();
const DAY = 86400000;
const patent: LibraryPatentSummary = {
  patentId: "00000000-0000-4000-8000-000000000001",
  name: "电池温控装置",
  customer: null,
  patentType: "invention",
  revision: 1,
  bookStatuses: {
    claims: "draft",
    description: "draft",
    "description-drawings": "unavailable",
    abstract: "draft",
    "abstract-drawing": "unavailable",
  },
  issueCount: 0,
  saveState: "saved",
  createdAt: new Date(now - 10 * DAY).toISOString(),
  modifiedAt: new Date(now - DAY).toISOString(),
  deletedAt: new Date(now - 3600000).toISOString(),
  recoveryState: "healthy",
  recoveryErrorCode: null,
};
const doc: LibraryDocumentSummary = {
  libraryDocumentId: "00000000-0000-4000-8000-000000000002",
  title: "写作草稿",
  snippet: "正文摘要",
  revision: 1,
  saveState: "saved",
  createdAt: new Date(now - 10 * DAY).toISOString(),
  modifiedAt: new Date(now - 3 * DAY).toISOString(),
  deletedAt: new Date(now - 3 * DAY).toISOString(),
  quarantinedAt: null,
  recoveryState: "healthy",
  recoveryErrorCode: null,
};
function Harness() {
  const [open, setOpen] = useState(false);
  const [patents, setPatents] = useState([
    patent,
    {
      ...patent,
      patentId: "00000000-0000-4000-8000-000000000003",
      name: "管道连接结构",
      patentType: "utility-model" as const,
      deletedAt: new Date(now - 2 * DAY).toISOString(),
    },
  ]);
  const [docs, setDocs] = useState(
    new URLSearchParams(location.search).has("many") ||
      new URLSearchParams(location.search).has("large")
      ? Array.from(
          { length: new URLSearchParams(location.search).has("large") ? 5000 : 30 },
          (_, index) => ({
            ...doc,
            libraryDocumentId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
            title: `长标题文档 ${index}：${"用于核对完整显示的专利名称".repeat(6)}`,
          }),
        )
      : [doc],
  );
  return (
    <div style={{ background: "#f4f6fa", height: "100vh", padding: 32, color: "#172033" }}>
      <h1>专利库</h1>
      <button type="button" onClick={() => setOpen(true)}>
        回收站
      </button>
      <div id="library-position" style={{ height: 120, overflow: "auto", marginTop: 20 }}>
        <div style={{ height: 1200 }}>专利库原来的滚动位置</div>
      </div>
      <MotionPresence>
        {open ? (
          <TrashDialog
            documents={docs}
            patents={patents}
            loading={false}
            error={null}
            onRetry={() => {}}
            onClose={() => setOpen(false)}
            onRestoreDocument={async (item) => {
              setDocs((current) =>
                current.filter((value) => value.libraryDocumentId !== item.libraryDocumentId),
              );
              return true;
            }}
            onRestorePatent={async (item) => {
              setPatents((current) => current.filter((value) => value.patentId !== item.patentId));
              return true;
            }}
            onDeleteDocument={async (item) => {
              setDocs((current) =>
                current.filter((value) => value.libraryDocumentId !== item.libraryDocumentId),
              );
              return true;
            }}
            onDeletePatent={async (item) => {
              setPatents((current) => current.filter((value) => value.patentId !== item.patentId));
              return true;
            }}
          />
        ) : null}
      </MotionPresence>
    </div>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);

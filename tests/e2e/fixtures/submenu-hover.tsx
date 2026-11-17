import { createRoot } from "react-dom/client";
import { MenuBar } from "../../../src/renderer/src/editor/ui/menu-bar";
import { DocumentLibrary } from "../../../src/renderer/src/library/document-library";
import "../../../src/renderer/src/app/app.css";

const mode = new URLSearchParams(location.search).get("library");
const noop = () => {};
const menu = (
  <MenuBar
    libraryMode={Boolean(mode)}
    onNewDocument={noop}
    onOpenDocument={noop}
    onSaveDocument={noop}
    onSaveDocumentAs={noop}
    onExportDocx={noop}
    onExportPdf={noop}
    onPrint={noop}
    onFind={noop}
    onReplace={noop}
    onOpenPageMargins={noop}
    onCreateDesktopShortcut={noop}
  />
);

const patents = Array.from({ length: 20 }, (_, index) => ({
  patentId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  name: `菜单层级测试专利 ${index}`,
  customer: null,
  patentType: "invention" as const,
  revision: 1,
  bookStatuses: {
    claims: "draft",
    description: "draft",
    abstract: "empty",
    "description-drawings": "empty",
    "abstract-drawing": "empty",
  } as const,
  issueCount: 0,
  saveState: "saved" as const,
  createdAt: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
  deletedAt: null,
  recoveryState: "healthy" as const,
  recoveryErrorCode: null,
}));

createRoot(document.getElementById("root")!).render(
  mode ? (
    <div className="window-shell is-library-active">
      <div className="patent-tabs" />
      <div className="app-view-transition-stage">
        <div className="standard-workspace-pane">
          <DocumentLibrary
            applicationMenu={menu}
            documents={[]}
            patents={patents}
            loading={false}
            patentLibraryViewMode={
              mode === "double" ? "double" : mode === "illustrated" ? "illustrated" : "single"
            }
            onNewDocument={noop}
            onImportPatdoc={noop}
            onOpenTrash={noop}
            onOpenDocument={noop}
            onRenameDocument={noop}
            onExportPatdoc={noop}
            onExportDocx={noop}
            onExportPdf={noop}
            onMoveToTrash={noop}
          />
        </div>
      </div>
      <footer />
    </div>
  ) : (
    menu
  ),
);

import { createRoot } from "react-dom/client";
import { SnapshotContentPreviewDialog } from "../../../src/renderer/src/settings/snapshot-preview/snapshot-content-preview-dialog";
import {
  createBlankBookDocument,
  DEFAULT_PARAGRAPH_ATTRIBUTES,
} from "../../../src/shared/document/defaults";
import type { PatentApi } from "../../../src/shared/ipc/contract";
import { PATENT_BOOK_ORDER } from "../../../src/shared/patent/model";
import type {
  SnapshotContentPreview,
  SnapshotPreviewFigure,
} from "../../../src/shared/snapshot/model";
import "../../../src/renderer/src/app/app.css";
import "../../../src/renderer/src/shared/standard-dialog.css";

const books = PATENT_BOOK_ORDER.map((kind) => ({
  kind,
  document: createBlankBookDocument("测试"),
}));
const preview = {
  current: { revision: 4, createdAt: "2026-09-11T04:00:00.000Z", books },
  baseline: null,
  comparison: "initial",
  skippedRevisions: [],
} as SnapshotContentPreview;

if (new URLSearchParams(location.search).has("figures")) {
  const figure = (index: number): SnapshotPreviewFigure => ({
    figureId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
    widthMm: 80,
  });
  const baselineFigures = Array.from({ length: 24 }, (_, index) => figure(index));
  preview.current.figures = [
    { ...figure(1), rotationDeg: 90 },
    ...baselineFigures.slice(2),
    figure(24),
    figure(25),
  ];
  baselineFigures[0] = { ...figure(0), rotationDeg: 270 };
  preview.baseline = {
    revision: 3,
    createdAt: "2026-09-11T03:00:00.000Z",
    books,
    figures: baselineFigures,
  };
  preview.comparison = "compared";
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 60;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("missing canvas context");
  context.fillStyle = "#2563eb";
  context.fillRect(0, 0, 180, 60);
  context.fillStyle = "#ffffff";
  context.fillRect(10, 10, 25, 20);
  const image = canvas.toDataURL("image/png").split(",")[1] ?? "";
  window.patentApi = {
    snapshot: {
      previewAsset: async () => ({
        ok: true,
        value: Uint8Array.from(atob(image), (char) => char.charCodeAt(0)),
      }),
    },
  } as unknown as PatentApi;
}

if (new URLSearchParams(location.search).has("auxiliary")) {
  const baselineDocument = createBlankBookDocument("技术材料");
  baselineDocument.content = Array.from({ length: 40 }, (_, index) => ({
    id: `00000000-0000-4000-8003-${String(index + 1).padStart(12, "0")}`,
    type: "paragraph" as const,
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text" as const, text: `第${index + 1}段：原有技术材料。`, marks: [] }],
  }));
  const currentDocument = structuredClone(baselineDocument);
  currentDocument.content.push({
    id: "00000000-0000-4000-8003-000000000041",
    type: "paragraph",
    attrs: { ...DEFAULT_PARAGRAPH_ATTRIBUTES },
    content: [{ type: "text", text: "末尾新增技术内容。", marks: [] }],
  });
  preview.current.auxiliaryDocuments = [
    { auxiliaryDocumentId: "materials", title: "技术材料", document: currentDocument },
  ];
  preview.baseline = {
    revision: 3,
    createdAt: "2026-09-11T03:00:00.000Z",
    books,
    auxiliaryDocuments: [
      { auxiliaryDocumentId: "materials", title: "技术材料", document: baselineDocument },
    ],
  };
  preview.comparison = "compared";
}

createRoot(document.getElementById("root")!).render(
  <SnapshotContentPreviewDialog
    preview={preview}
    documentId="00000000-0000-4000-8000-000000000921"
    onClose={() => {}}
  />,
);

import { render, screen, waitFor } from "@testing-library/react";
import type { SnapshotPreviewFigure } from "../../../../shared/snapshot/model";
import { SnapshotFiguresPreview } from "./snapshot-figures-preview";

const documentId = "00000000-0000-4000-8000-000000000911";
const revision = 5;

test("labels the selected abstract image without inventing a new figure number", async () => {
  render(
    <SnapshotFiguresPreview
      title="摘要附图"
      figures={[figure(7)]}
      baselineFigures={[]}
      documentId={documentId}
      currentRevision={revision}
    />,
  );
  expect(screen.getByRole("heading", { name: "摘要附图" })).toBeDefined();
  expect(await screen.findByRole("img", { name: "摘要附图" })).toBeDefined();
  expect(screen.queryByText("图1")).toBeNull();
});

test("uses snapshot rotations for both current and deleted baseline images", async () => {
  render(
    <SnapshotFiguresPreview
      figures={[{ ...figure(2), rotationDeg: 90 }]}
      baselineFigures={[{ ...figure(1), rotationDeg: 270 }]}
      documentId={documentId}
      currentRevision={revision}
      baselineRevision={4}
    />,
  );
  const current = await screen.findByRole("img", { name: "图1" });
  const deleted = await screen.findByRole("img", { name: "原图1（已删除）" });
  expect(current.style.transform).toContain("rotate(90deg)");
  expect(deleted.style.transform).toContain("rotate(270deg)");
});

function figure(index: number): SnapshotPreviewFigure {
  return {
    figureId: `00000000-0000-4000-8002-${index.toString(16).padStart(12, "0")}`,
    assetId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
    widthMm: 80,
  };
}

const objectUrls: string[] = [];
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  URL.createObjectURL = (_blob: Blob) => {
    const url = `blob:snapshot-${objectUrls.length}`;
    objectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

beforeEach(() => {
  objectUrls.length = 0;
  window.patentApi = {
    snapshot: {
      previewAsset: vi.fn().mockResolvedValue({ ok: true, value: Uint8Array.from([1, 2, 3]) }),
    },
  } as never;
});

test("renders every snapshot figure in order with its label", async () => {
  const figures = [figure(1), figure(2)];
  render(
    <SnapshotFiguresPreview
      figures={figures}
      baselineFigures={[]}
      documentId={documentId}
      currentRevision={revision}
    />,
  );

  expect(screen.getByRole("heading", { name: "说明书附图" })).toBeDefined();
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole("img", { name: "图1" })).toBeDefined());
  expect(screen.getByRole("img", { name: "图2" })).toBeDefined();
  expect(screen.getByText("图1")).toBeDefined();
  expect(screen.getByText("图2")).toBeDefined();
  await waitFor(() =>
    expect(window.patentApi.snapshot.previewAsset).toHaveBeenCalledWith({
      documentType: "patent",
      documentId,
      revision,
      assetId: figures[0]?.assetId,
    }),
  );
});

test("shows added-count badge when current has more figures than baseline", () => {
  render(
    <SnapshotFiguresPreview
      figures={[figure(1), figure(2), figure(3)]}
      baselineFigures={[figure(1)]}
      documentId={documentId}
      currentRevision={revision}
    />,
  );
  expect(screen.getByText("新增 2 张")).toBeDefined();
});

test("counts insertions by identity when other figures were deleted", () => {
  render(
    <SnapshotFiguresPreview
      figures={[figure(2), figure(3), figure(4)]}
      baselineFigures={[figure(1), figure(2)]}
      documentId={documentId}
      currentRevision={revision}
      baselineRevision={4}
    />,
  );
  expect(screen.getByText("新增 2 张")).toBeDefined();
  expect(screen.getByText("删除 1 张")).toBeDefined();
});

test("renders deleted figures from their baseline revision with navigation targets", async () => {
  const { container } = render(
    <SnapshotFiguresPreview
      figures={[figure(2)]}
      baselineFigures={[figure(1), figure(2)]}
      documentId={documentId}
      currentRevision={revision}
      baselineRevision={4}
    />,
  );
  await waitFor(() =>
    expect(window.patentApi.snapshot.previewAsset).toHaveBeenCalledWith({
      documentType: "patent",
      documentId,
      revision: 4,
      assetId: figure(1).assetId,
    }),
  );
  expect(
    container.querySelector(`[data-snapshot-figure-id="${figure(1).figureId}"]`),
  ).not.toBeNull();
  expect(
    container.querySelector(`[data-snapshot-figure-id="${figure(2).figureId}"]`),
  ).not.toBeNull();
});

test("renders an empty state without baseline figures and a deletion hint with baseline figures", () => {
  const { rerender } = render(
    <SnapshotFiguresPreview
      figures={[]}
      baselineFigures={[]}
      documentId={documentId}
      currentRevision={revision}
    />,
  );
  expect(screen.getByText("该版本没有附图。")).toBeDefined();

  rerender(
    <SnapshotFiguresPreview
      figures={[]}
      baselineFigures={[figure(1)]}
      documentId={documentId}
      currentRevision={revision}
    />,
  );
  expect(screen.getByText("该版本没有附图（基线版本仍有附图，可能已被删除）。")).toBeDefined();
});

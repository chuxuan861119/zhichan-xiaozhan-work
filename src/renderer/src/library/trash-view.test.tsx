import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LibraryDocumentSummary, LibraryPatentSummary } from "../../../shared/library/model";
import { spatialMotionTiming } from "../shared/spatial-motion";
import { TrashView } from "./trash-view";

test("blocks permanent deletion for 24 hours without blocking restore and unlocks while open", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T23:59:59Z"));
  const onRestorePatent = vi.fn();
  const onPermanentlyDeletePatent = vi.fn();
  const { unmount } = render(
    <TrashView
      documents={[]}
      patents={[trashedPatentSummary()]}
      loading={false}
      onBackToLibrary={vi.fn()}
      onRestoreDocument={vi.fn()}
      onPermanentlyDeleteDocument={vi.fn()}
      onRestorePatent={onRestorePatent}
      onPermanentlyDeletePatent={onPermanentlyDeletePatent}
    />,
  );
  try {
    const button = screen.getByRole("button", { name: "永久删除 可调式夹具" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onPermanentlyDeletePatent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "恢复 可调式夹具" }));
    expect(onRestorePatent).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1000));
    expect(button).toHaveProperty("disabled", false);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

function trashedSummary(overrides: Partial<LibraryDocumentSummary> = {}): LibraryDocumentSummary {
  return {
    libraryDocumentId: overrides.libraryDocumentId ?? "00000000-0000-4000-8000-000000000201",
    title: overrides.title ?? "旧说明书",
    snippet: "待恢复的旧文档。",
    revision: 3,
    saveState: "saved",
    createdAt: "2026-07-01T00:00:00.000Z",
    modifiedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: "2026-08-01T00:00:00.000Z",
    quarantinedAt: null,
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

test("slides remaining trash cards into place after an item is restored or deleted", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
  HTMLElement.prototype.animate = animate;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const card = this.closest<HTMLElement>(".library-card");
    const index = card?.parentElement ? Array.from(card.parentElement.children).indexOf(card) : 0;
    const top = Math.max(0, index) * 100;
    return {
      width: 500,
      height: 80,
      top,
      bottom: top + 80,
      left: 0,
      right: 500,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  const first = trashedSummary();
  const second = trashedSummary({
    libraryDocumentId: "00000000-0000-4000-8000-000000000202",
    title: "第二份说明书",
  });
  const handlers = {
    onBackToLibrary: vi.fn(),
    onRestoreDocument: vi.fn(),
    onPermanentlyDeleteDocument: vi.fn(),
  };

  try {
    const { rerender } = render(
      <TrashView documents={[first, second]} loading={false} {...handlers} />,
    );
    animate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "恢复 旧说明书" }));
    rerender(<TrashView documents={[second]} loading={false} {...handlers} />);

    await vi.waitFor(() =>
      expect(animate).toHaveBeenCalledWith(
        [{ transform: "translate(0px, 100px)" }, { transform: "translate(0, 0)" }],
        expect.objectContaining(spatialMotionTiming(100)),
      ),
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

function trashedPatentSummary(): LibraryPatentSummary {
  return {
    patentId: "00000000-0000-4000-8000-000000000301",
    name: "可调式夹具",
    customer: null,
    patentType: "utility-model",
    revision: 4,
    bookStatuses: {
      claims: "draft",
      description: "complete",
      "description-drawings": "draft",
      abstract: "draft",
      "abstract-drawing": "empty",
    },
    issueCount: 0,
    saveState: "saved",
    createdAt: "2026-07-01T00:00:00.000Z",
    modifiedAt: "2026-08-02T00:00:00.000Z",
    deletedAt: "2026-08-02T00:00:00.000Z",
    recoveryState: "healthy",
    recoveryErrorCode: null,
  };
}

test("shows trash retention date and actions", async () => {
  const user = userEvent.setup();
  const handlers = {
    onBackToLibrary: vi.fn(),
    onRestoreDocument: vi.fn(),
    onPermanentlyDeleteDocument: vi.fn(),
  };
  render(<TrashView documents={[trashedSummary()]} loading={false} {...handlers} />);

  expect(screen.getByRole("heading", { name: "回收站" })).toBeDefined();
  expect(screen.getByRole("button", { name: "返回专利库" })).toBeDefined();
  const article = screen.getByRole("article", { name: "旧说明书" });
  expect(within(article).getByText(/1\s*年后自动清理/u)).toBeDefined();
  expect(within(article).getByText(/2027\/8\/1/u)).toBeDefined();

  await user.click(within(article).getByRole("button", { name: "恢复 旧说明书" }));
  await user.click(within(article).getByRole("button", { name: "永久删除 旧说明书" }));
  expect(handlers.onRestoreDocument).toHaveBeenCalledWith(trashedSummary());
  expect(handlers.onPermanentlyDeleteDocument).toHaveBeenCalledWith(trashedSummary());
});

test("shows trashed patents with type, retention date and patent actions", async () => {
  const user = userEvent.setup();
  const patent = trashedPatentSummary();
  const handlers = {
    onBackToLibrary: vi.fn(),
    onRestoreDocument: vi.fn(),
    onPermanentlyDeleteDocument: vi.fn(),
    onRestorePatent: vi.fn(),
    onPermanentlyDeletePatent: vi.fn(),
  };
  render(<TrashView documents={[]} patents={[patent]} loading={false} {...handlers} />);

  const article = screen.getByRole("article", { name: "可调式夹具" });
  expect(within(article).getByText(/实用新型/u)).toBeDefined();
  expect(within(article).getByText(/1\s*年后自动清理/u)).toBeDefined();
  expect(within(article).getByText(/2027\/8\/2/u)).toBeDefined();

  await user.click(within(article).getByRole("button", { name: "恢复 可调式夹具" }));
  await user.click(within(article).getByRole("button", { name: "永久删除 可调式夹具" }));
  expect(handlers.onRestorePatent).toHaveBeenCalledWith(patent);
  expect(handlers.onPermanentlyDeletePatent).toHaveBeenCalledWith(patent);
});

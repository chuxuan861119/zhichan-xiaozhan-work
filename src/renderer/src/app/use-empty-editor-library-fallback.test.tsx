import { renderHook } from "@testing-library/react";
import { useEmptyEditorLibraryFallback } from "./use-empty-editor-library-fallback";

test("returns an empty editor to the library", () => {
  const setView = vi.fn();
  renderHook(() => useEmptyEditorLibraryFallback("editor", false, setView));
  expect(setView).toHaveBeenCalledExactlyOnceWith("library");
});

test("returns to the library when the last open document disappears", () => {
  const setView = vi.fn();
  const { rerender } = renderHook(
    ({ hasDocument }) => useEmptyEditorLibraryFallback("editor", hasDocument, setView),
    { initialProps: { hasDocument: true } },
  );
  expect(setView).not.toHaveBeenCalled();
  rerender({ hasDocument: false });
  expect(setView).toHaveBeenCalledExactlyOnceWith("library");
});

test.each(["library", "trash"] as const)("does not redirect the %s page", (view) => {
  const setView = vi.fn();
  renderHook(() => useEmptyEditorLibraryFallback(view, false, setView));
  expect(setView).not.toHaveBeenCalled();
});

test("does not interrupt opening a document or switching between open documents", () => {
  const setView = vi.fn();
  const { rerender } = renderHook(
    ({ view, hasDocument }: { view: "library" | "editor"; hasDocument: boolean }) =>
      useEmptyEditorLibraryFallback(view, hasDocument, setView),
    { initialProps: { view: "library" as "library" | "editor", hasDocument: false } },
  );
  rerender({ view: "library", hasDocument: true });
  rerender({ view: "editor", hasDocument: true });
  rerender({ view: "editor", hasDocument: true });
  expect(setView).not.toHaveBeenCalled();
});

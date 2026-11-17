import { useEffect } from "react";

export function useEmptyEditorLibraryFallback(
  view: "library" | "editor" | "trash",
  hasOpenDocument: boolean,
  setView: (view: "library" | "editor" | "trash") => void,
): void {
  useEffect(() => {
    if (view === "editor" && !hasOpenDocument) setView("library");
  }, [view, hasOpenDocument, setView]);
}

import { useEffect } from "react";
import { ignoreApplicationKeyEvent } from "../../../shared/platform";

const TEXT_INPUT_TYPES = new Set(["email", "number", "password", "search", "tel", "text", "url"]);

export function isSelectAllEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  if (target.closest('math-field, [data-select-all-scope="text"]')) return true;

  const input = target.closest("input");
  if (input instanceof HTMLInputElement) {
    return !input.disabled && !input.readOnly && TEXT_INPUT_TYPES.has(input.type);
  }

  const textarea = target.closest("textarea");
  if (textarea instanceof HTMLTextAreaElement) return !textarea.disabled && !textarea.readOnly;

  const contentEditable = target.closest("[contenteditable]");
  return Boolean(
    contentEditable && contentEditable.getAttribute("contenteditable")?.toLowerCase() !== "false",
  );
}

export function handleGlobalSelectAll(event: KeyboardEvent): void {
  if (event.defaultPrevented || ignoreApplicationKeyEvent(event) || event.altKey || event.shiftKey)
    return;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
  if (!isSelectAllEditingTarget(event.target)) event.preventDefault();
}

export function useGlobalSelectAllGuard(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalSelectAll, true);
    return () => window.removeEventListener("keydown", handleGlobalSelectAll, true);
  }, []);
}

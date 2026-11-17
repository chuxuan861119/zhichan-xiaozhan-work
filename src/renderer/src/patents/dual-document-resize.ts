export const DUAL_DOCUMENT_RESIZE_SETTLED_EVENT = "dual-document-resize-settled";

export function dualDocumentResizeIsActive(element: Element | null | undefined): boolean {
  return Boolean(
    element?.closest<HTMLElement>('.dual-document-workspace[data-split-resizing="true"]'),
  );
}

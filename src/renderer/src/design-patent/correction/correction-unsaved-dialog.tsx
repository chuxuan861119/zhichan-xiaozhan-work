import { useEffect, useId, useRef } from "react";

type Props = {
  onStay(): void;
  onDiscard(): void;
  onApply(): void;
  presentation?: {
    title: string;
    description: string;
    stay: string;
    discard: string;
    apply: string;
  };
};

export function CorrectionUnsavedDialog({ onStay, onDiscard, onApply, presentation }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    applyRef.current?.focus();

    const background = Array.from(backdrop.parentElement?.children ?? []).filter(
      (element) => element !== backdrop,
    );
    const attributes = background.map((element) => ({
      element,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
    }));
    background.forEach((element) => {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
    });

    const keepFocusInDialog = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) applyRef.current?.focus();
    };
    const blockBackground = (event: Event) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("focusin", keepFocusInDialog);
    document.addEventListener("pointerdown", blockBackground, true);
    document.addEventListener("click", blockBackground, true);
    return () => {
      document.removeEventListener("focusin", keepFocusInDialog);
      document.removeEventListener("pointerdown", blockBackground, true);
      document.removeEventListener("click", blockBackground, true);
      attributes.forEach(({ element, ariaHidden, inert }) => {
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
        if (!inert) element.removeAttribute("inert");
      });
      previousFocus.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onStay();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    );
    const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex >= focusable.length - 1
        ? 0
        : currentIndex + 1;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  };

  return (
    <div ref={backdropRef} className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="close-dialog klecks-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>{presentation?.title ?? "未应用的图片修改"}</h2>
        <p id={descriptionId}>{presentation?.description ?? "当前图片有未应用的修改。"}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onStay}>
            {presentation?.stay ?? "留在当前图片"}
          </button>
          <button type="button" onClick={onDiscard}>
            {presentation?.discard ?? "放弃修改"}
          </button>
          <button ref={applyRef} type="button" className="primary-button" onClick={onApply}>
            {presentation?.apply ?? "应用修改"}
          </button>
        </div>
      </section>
    </div>
  );
}

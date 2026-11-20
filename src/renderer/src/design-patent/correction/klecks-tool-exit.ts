/** Escape is observed before gesture handlers consume it, but release happens after rollback. */
export function bindKlecksToolExit(scope: HTMLElement, enabled: () => boolean, exit: () => void) {
  let live = true;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || !enabled()) return;
    if (
      event
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.isContentEditable ||
              node.matches("input,textarea,select,[role='textbox'],[role='dialog'],dialog")),
        )
    )
      return;
    event.preventDefault();
    queueMicrotask(() => {
      if (live && enabled()) exit();
    });
  };
  scope.addEventListener("keydown", onKey, true);
  return () => {
    live = false;
    scope.removeEventListener("keydown", onKey, true);
  };
}

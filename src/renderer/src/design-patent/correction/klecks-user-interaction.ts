/** Cross-frame input notification only; never intercepts or changes editor operations. */
export function bindKlecksUserInteraction(target: EventTarget, notify: () => void) {
  const types = ["pointerdown", "wheel", "keydown"] as const;
  for (const type of types) target.addEventListener(type, notify, { capture: true, passive: true });
  return () => {
    for (const type of types) target.removeEventListener(type, notify, true);
  };
}

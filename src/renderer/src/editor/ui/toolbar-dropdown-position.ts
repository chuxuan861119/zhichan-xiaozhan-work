/** Toolbar menus share its lower edge while other floating tools keep their own anchor. */
export function toolbarDropdownPosition(trigger: HTMLElement, component = trigger, popupWidth = 0) {
  const toolbar = trigger.closest<HTMLElement>(".tool-bar");
  if (!toolbar) return null;
  return {
    top: toolbar.getBoundingClientRect().bottom,
    left: Math.max(
      8,
      Math.min(component.getBoundingClientRect().left, window.innerWidth - popupWidth - 8),
    ),
  };
}

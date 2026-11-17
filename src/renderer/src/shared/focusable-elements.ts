const SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function isVisibleControl(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
  }
  return true;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(SELECTOR)].filter(
    (element) => element.tabIndex >= 0 && isVisibleControl(element),
  );
}

/** Mounted but closed modeless windows must not block editor focus or shortcuts. */
export function hasVisibleElement(selector: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(selector)].some(isVisibleControl);
}

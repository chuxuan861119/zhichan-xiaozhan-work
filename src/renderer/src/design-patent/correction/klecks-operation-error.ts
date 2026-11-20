import { isKlecksResourceLimit, KLECKS_RESOURCE_LIMIT_MESSAGE } from "./klecks-resource-budget";
import { bindKlecksUserInteraction } from "./klecks-user-interaction";

/** Expected, non-mutating operation rejection, not an engine failure. */
export class KlecksOperationRejected extends Error {}

/** State updates finish the same async operation; they must not erase its feedback. */
export function bindKlecksOperationFeedback(element: HTMLElement, target: EventTarget) {
  const release = bindKlecksUserInteraction(target, () => {
    if (element.dataset.recoverable === "true") element.hidden = true;
  });
  return {
    error: (error?: unknown) => presentKlecksOperationError(element, error),
    changed: () => {
      if (element.dataset.recoverable !== "true") element.hidden = true;
    },
    release,
  };
}

export function presentKlecksOperationError(element: HTMLElement, error?: unknown): void {
  const rejected = error instanceof KlecksOperationRejected;
  const resourceLimit = isKlecksResourceLimit(error);
  element.dataset.recoverable = String(rejected || resourceLimit);
  element.setAttribute("role", rejected || resourceLimit ? "status" : "alert");
  element.textContent = rejected
    ? error.message
    : resourceLimit
      ? KLECKS_RESOURCE_LIMIT_MESSAGE
      : "图片编辑器暂时无法完成操作，请返回工作台重试。";
  element.hidden = false;
}

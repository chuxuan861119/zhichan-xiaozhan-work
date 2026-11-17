import type { CanonicalPatent } from "../../../../shared/patent/model";

export function matchesReferenceMarkPlanBase(
  current: CanonicalPatent,
  before: CanonicalPatent,
): boolean {
  const { activeBookKind: _currentActiveBookKind, ...currentContent } = current;
  const { activeBookKind: _beforeActiveBookKind, ...beforeContent } = before;
  return JSON.stringify(currentContent) === JSON.stringify(beforeContent);
}

import type { PatentBookKind } from "../../../shared/patent/model";

export function supportsDualColumns(kind: PatentBookKind): boolean {
  return kind === "claims" || kind === "description";
}

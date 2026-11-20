import {
  type DesignPatent,
  type DesignPatentPrimarySlot,
  isAssignedDesignView,
} from "../../../../shared/patent/design-patent";
import { assignView } from "./design-assignment";

export function applyDesignViewAssignment(
  design: DesignPatent,
  viewId: string,
  kind: DesignPatentPrimarySlot | "unassigned",
): DesignPatent {
  const command = assignView(design.views, viewId, kind);
  if (!command.changed) return design;
  const holding = new Set(
    command.views.filter((view) => !isAssignedDesignView(view)).map((view) => view.viewId),
  );
  const assigned = new Map(command.views.map((view) => [view.viewId, view]));
  return {
    ...design,
    brief: {
      ...design.brief,
      omissions: design.brief.omissions.filter(
        (item) => kind === "unassigned" || item.viewKind !== kind,
      ),
    },
    views: design.views.map((view) => ({ ...view, ...assigned.get(view.viewId) })),
    representativeViewId:
      design.representativeViewId && holding.has(design.representativeViewId)
        ? null
        : design.representativeViewId,
    dimensionReferenceViewId:
      design.dimensionReferenceViewId && holding.has(design.dimensionReferenceViewId)
        ? null
        : design.dimensionReferenceViewId,
  };
}

/** Save first; recompute from authoritative current state to retain newly saved layer references. */
export async function saveAndAssignDesignView(
  viewId: string,
  kind: DesignPatentPrimarySlot | "unassigned",
  dependencies: {
    read(): DesignPatent | null;
    save(viewIds: string[]): Promise<unknown>;
    commit(design: DesignPatent): void | Promise<void>;
  },
) {
  const before = dependencies.read();
  if (!before) throw new Error("外观设计会话已关闭。");
  const planned = applyDesignViewAssignment(before, viewId, kind);
  if (planned === before) return;
  const roles = (design: DesignPatent) =>
    JSON.stringify(
      design.views.map((view) => [view.viewId, view.kind, view.assetId, view.operations]),
    );
  const expectedRoles = roles(before);
  const retiring = before.views.filter(
    (view) =>
      isAssignedDesignView(view) &&
      !planned.views.some((next) => next.viewId === view.viewId && isAssignedDesignView(next)),
  );
  if (retiring.length) await dependencies.save(retiring.map((view) => view.viewId));
  const current = dependencies.read();
  if (!current || roles(current) !== expectedRoles)
    throw new Error("图片分配已变化，本次移动未执行，请重试。");
  await dependencies.commit(applyDesignViewAssignment(current, viewId, kind));
}

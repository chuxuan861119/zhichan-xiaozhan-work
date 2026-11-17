import type { FlowchartProjectDescriptor } from "../../../shared/flowcharts/model";

const MAX_PROJECT_NAME_LENGTH = 200;

export function sortFlowchartProjects(
  projects: readonly FlowchartProjectDescriptor[],
): FlowchartProjectDescriptor[] {
  return [...projects].sort(
    (left, right) =>
      Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) ||
      left.projectId.localeCompare(right.projectId),
  );
}

export function buildAutomaticFlowchartName(
  patentName: string | null | undefined,
  projects: readonly Pick<FlowchartProjectDescriptor, "name">[],
): string {
  const base = patentName?.trim() || "未命名专利";
  const occupied = new Set(projects.map((project) => project.name));
  for (let index = 1; ; index += 1) {
    const suffix = `-流程图${index}`;
    const candidate = `${base.slice(0, MAX_PROJECT_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

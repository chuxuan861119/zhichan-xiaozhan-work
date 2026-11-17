import { z } from "zod";
import { type DrawingProject, DrawingProjectsSchema } from "./model.js";

export const DrawingProjectEditsSchema = z
  .object({
    projectIds: z.array(z.string().uuid()).max(1000),
    projects: DrawingProjectsSchema,
  })
  .strict()
  .superRefine((edit, context) => {
    const ids = new Set(edit.projectIds),
      changed = new Set(edit.projects.map((p) => p.projectId));
    if (
      ids.size !== edit.projectIds.length ||
      changed.size !== edit.projects.length ||
      edit.projects.some((p) => !ids.has(p.projectId))
    )
      context.addIssue({ code: "custom", message: "图纸编辑编号重复或不在图纸列表中。" });
  });
export type DrawingProjectEdits = z.infer<typeof DrawingProjectEditsSchema>;

/** Ordered upserts; absence from projectIds deletes a drawing. The file format stays unchanged. */
export function drawingProjectEdits(
  before: DrawingProject[],
  after: DrawingProject[],
): DrawingProjectEdits {
  const previous = new Map(before.map((p) => [p.projectId, p]));
  return {
    projectIds: after.map((p) => p.projectId),
    projects: after.filter((p) => p !== previous.get(p.projectId)),
  };
}

export function applyDrawingProjectEdits(
  before: DrawingProject[],
  edit: DrawingProjectEdits,
): DrawingProject[] {
  const ids = new Set(edit.projectIds),
    updates = new Set(edit.projects.map((p) => p.projectId));
  if (
    ids.size !== edit.projectIds.length ||
    updates.size !== edit.projects.length ||
    edit.projects.some((p) => !ids.has(p.projectId))
  )
    throw new Error("图纸编辑编号重复或不在图纸列表中。");
  const projects = new Map(before.map((p) => [p.projectId, p]));
  for (const p of edit.projects) projects.set(p.projectId, p);
  return edit.projectIds.map((id) => {
    const project = projects.get(id);
    if (!project) throw new Error("图纸编辑包含不存在的图纸。");
    return project;
  });
}

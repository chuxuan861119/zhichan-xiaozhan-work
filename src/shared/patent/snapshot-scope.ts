import { drawingAssetIds } from "../drawing-markup/cad-state.js";
import { retainCurrentPatentAssets } from "./asset-references.js";
import { normalizeDrawingBooks } from "./drawing-content.js";
import {
  CANONICAL_PATENT_FORMAT_VERSION,
  type CanonicalPatent,
  CanonicalPatentSchema,
} from "./model.js";

export function documentSnapshotFigures(
  figures: CanonicalPatent["figures"],
): CanonicalPatent["figures"] {
  return figures.map(({ flowchartLink: _flowchartLink, ...figure }) => figure);
}

/** Patent history protects published document content, not independent graphic workspaces. */
export function patentDocumentSnapshot(patent: CanonicalPatent): CanonicalPatent {
  // CAD capability versions must not make an otherwise unchanged document look
  // different. Re-derive the version from the document's retained resources only.
  return CanonicalPatentSchema.parse(
    retainCurrentPatentAssets({
      ...patent,
      formatVersion: CANONICAL_PATENT_FORMAT_VERSION,
      drawingProjects: [],
      flowchartProjects: [],
      figures: documentSnapshotFigures(patent.figures),
    }),
  );
}

export function preserveCurrentGraphicWorkspaces(
  document: CanonicalPatent,
  current: Pick<CanonicalPatent, "drawingProjects" | "assets" | "flowchartProjects" | "figures">,
): CanonicalPatent {
  const used = new Set<string>();
  for (const project of current.drawingProjects) {
    for (const id of drawingAssetIds(project)) used.add(id);
    for (const region of project.regions) if (region.bodyAssetId) used.add(region.bodyAssetId);
  }
  const projected = patentDocumentSnapshot(document);
  const projectIds = new Set(current.flowchartProjects.map((project) => project.projectId));
  const liveFigures = new Map(current.figures.map((figure) => [figure.figureId, figure]));
  return CanonicalPatentSchema.parse(
    retainCurrentPatentAssets({
      ...projected,
      drawingProjects: current.drawingProjects,
      flowchartProjects: current.flowchartProjects,
      figures: projected.figures.map((figure) => {
        const live = liveFigures.get(figure.figureId);
        return live?.assetId === figure.assetId &&
          live.flowchartLink &&
          projectIds.has(live.flowchartLink.projectId)
          ? { ...figure, flowchartLink: live.flowchartLink }
          : figure;
      }),
      assets: [
        ...new Map(
          [...projected.assets, ...current.assets.filter((a) => used.has(a.assetId))].map((a) => [
            a.assetId,
            a,
          ]),
        ).values(),
      ],
    }),
  );
}

export function patentSnapshotContent(patent: CanonicalPatent) {
  // The first figure transaction normalizes legacy drawing books even when only
  // CAD changed. Compare their canonical document form, not that storage marker.
  const {
    revision: _revision,
    modifiedAt: _modifiedAt,
    ...content
  } = patentDocumentSnapshot({
    ...patent,
    books: normalizeDrawingBooks(patent),
  });
  return content;
}

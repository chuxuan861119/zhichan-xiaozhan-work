import { useLayoutEffect, useMemo, useState } from "react";
import type { PatentBookDocument } from "../../../shared/document/model";
import {
  buildDocumentStructureRulerModel,
  buildDrawingFigureRulerMarkers,
  type DocumentStructureRulerModel,
} from "../../../shared/patent/document-structure-ruler";
import type { PatentFigure } from "../../../shared/patent/model";
import { AdaptiveRulerScheduler, isComplexRulerDocument } from "./adaptive-ruler-scheduler";
import { createRulerModelCalculator } from "./ruler-model-cache";

type RulerSource =
  | {
      document: PatentBookDocument;
      bookKind: "claims" | "description";
      editorId: string;
      figures?: never;
    }
  | { figures: readonly PatentFigure[]; document?: never; bookKind?: never; editorId?: never };

function calculate(source: RulerSource): DocumentStructureRulerModel {
  return source.figures
    ? { markers: buildDrawingFigureRulerMarkers(source.figures), issues: [] }
    : buildDocumentStructureRulerModel(source.document, source.bookKind);
}

export function useAdaptiveRulerModel(source: RulerSource): DocumentStructureRulerModel {
  const [model, setModel] = useState(() => calculate(source));
  const sourceKey = source.editorId ? `${source.editorId}:${source.bookKind}` : "drawings";
  // A source change discards both timing history and pending work; same-kind
  // books belonging to different patents must never share a pending model.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceKey identifies the scheduler lifetime.
  const scheduler = useMemo(() => {
    const calculateDocument = createRulerModelCalculator();
    return new AdaptiveRulerScheduler(
      (next: RulerSource) =>
        next.figures ? calculate(next) : calculateDocument(next.document, next.bookKind),
      setModel,
    );
  }, [sourceKey]);
  useLayoutEffect(() => () => scheduler.cancel(), [scheduler]);
  const { document, bookKind, editorId, figures } = source;
  useLayoutEffect(() => {
    if (figures) {
      scheduler.update({ figures }, false);
    } else if (document && bookKind && editorId !== undefined) {
      scheduler.update({ document, bookKind, editorId }, isComplexRulerDocument(document));
    }
  }, [scheduler, document, bookKind, editorId, figures]);
  return model;
}

export type PromptCoverageBlock = Readonly<{ id: string; text: string }>;
export type PromptCoverageSpan = Readonly<{
  blockId: string;
  startOffset: number;
  endOffset: number;
}>;

export type CorrectionPromptCapabilities = Readonly<{
  completeDocument: boolean;
}>;

/**
 * Determines whether a selection covers every non-empty block of one document.
 * The calculation deliberately uses the persisted block text and offsets rather
 * than a renderer-provided "select all" flag.
 */
export function calculateDocumentCoverage(
  blocks: readonly PromptCoverageBlock[],
  spans: readonly PromptCoverageSpan[],
): CorrectionPromptCapabilities {
  const nonEmptyBlocks = blocks.filter((block) => block.text.length > 0);
  if (nonEmptyBlocks.length === 0) return { completeDocument: false };

  const spansById = new Map(spans.map((span) => [span.blockId, span]));
  const hasUniqueSpans = spansById.size === spans.length;
  const hasValidOffsets = spans.every((span) => {
    const block = blocks.find((candidate) => candidate.id === span.blockId);
    return (
      block !== undefined &&
      span.startOffset >= 0 &&
      span.endOffset >= span.startOffset &&
      span.endOffset <= block.text.length
    );
  });
  const coversEveryBlock = nonEmptyBlocks.every((block) => {
    const span = spansById.get(block.id);
    return span?.startOffset === 0 && span.endOffset === block.text.length;
  });
  const hasOnlyKnownBlocks = spans.every((span) =>
    blocks.some((block) => block.id === span.blockId),
  );
  return {
    completeDocument: coversEveryBlock && hasOnlyKnownBlocks && hasUniqueSpans && hasValidOffsets,
  };
}

export function capabilitiesFromSegments(
  segments: readonly { requestContext?: { completeDocument: boolean } }[],
): CorrectionPromptCapabilities {
  return {
    completeDocument:
      segments.length > 0 &&
      segments.every((segment) => segment.requestContext?.completeDocument === true),
  };
}

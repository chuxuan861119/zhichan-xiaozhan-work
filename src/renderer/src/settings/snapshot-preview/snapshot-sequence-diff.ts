export interface SequenceDiffRun<T> {
  readonly kind: "equal" | "insert" | "delete";
  readonly before: readonly T[];
  readonly after: readonly T[];
}

type DiffStep<T> =
  | { readonly kind: "equal"; readonly before: T; readonly after: T }
  | { readonly kind: "delete"; readonly before: T }
  | { readonly kind: "insert"; readonly after: T };

const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export function segmentGraphemes(text: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

export function diffSequence<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (value: T) => string,
): readonly SequenceDiffRun<T>[] {
  const beforeKeys = before.map(keyOf);
  const afterKeys = after.map(keyOf);
  const steps: DiffStep<T>[] = [];
  appendDiff(before, after, beforeKeys, afterKeys, 0, before.length, 0, after.length, steps);
  return coalesceSteps(steps);
}

function appendDiff<T>(
  before: readonly T[],
  after: readonly T[],
  beforeKeys: readonly string[],
  afterKeys: readonly string[],
  initialBeforeStart: number,
  initialBeforeEnd: number,
  initialAfterStart: number,
  initialAfterEnd: number,
  steps: DiffStep<T>[],
): void {
  let beforeStart = initialBeforeStart;
  let beforeEnd = initialBeforeEnd;
  let afterStart = initialAfterStart;
  let afterEnd = initialAfterEnd;

  while (
    beforeStart < beforeEnd &&
    afterStart < afterEnd &&
    beforeKeys[beforeStart] === afterKeys[afterStart]
  ) {
    steps.push({ kind: "equal", before: before[beforeStart]!, after: after[afterStart]! });
    beforeStart += 1;
    afterStart += 1;
  }

  let suffixLength = 0;
  while (
    beforeStart < beforeEnd &&
    afterStart < afterEnd &&
    beforeKeys[beforeEnd - 1] === afterKeys[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
    suffixLength += 1;
  }

  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  if (beforeLength === 0) {
    appendInserts(after, afterStart, afterEnd, steps);
  } else if (afterLength === 0) {
    appendDeletes(before, beforeStart, beforeEnd, steps);
  } else if (beforeLength === 1 || afterLength === 1) {
    appendSingleItemDiff(
      before,
      after,
      beforeKeys,
      afterKeys,
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
      steps,
    );
  } else {
    const [splitBefore, splitAfter] = findMiddleSplit(
      beforeKeys,
      afterKeys,
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
    );
    appendDiff(
      before,
      after,
      beforeKeys,
      afterKeys,
      beforeStart,
      splitBefore,
      afterStart,
      splitAfter,
      steps,
    );
    appendDiff(
      before,
      after,
      beforeKeys,
      afterKeys,
      splitBefore,
      beforeEnd,
      splitAfter,
      afterEnd,
      steps,
    );
  }

  for (let offset = 0; offset < suffixLength; offset += 1) {
    steps.push({
      kind: "equal",
      before: before[beforeEnd + offset]!,
      after: after[afterEnd + offset]!,
    });
  }
}

function findMiddleSplit(
  beforeKeys: readonly string[],
  afterKeys: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
): readonly [number, number] {
  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  const maximumDistance = Math.ceil((beforeLength + afterLength) / 2);
  const offset = maximumDistance + 1;
  const vectorLength = maximumDistance * 2 + 3;
  const forward = new Int32Array(vectorLength);
  const reverse = new Int32Array(vectorLength);
  forward.fill(-1);
  reverse.fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = beforeLength - afterLength;
  const oddDelta = delta % 2 !== 0;

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x =
        diagonal === -distance ||
        (diagonal !== distance && forward[index - 1]! < forward[index + 1]!)
          ? forward[index + 1]!
          : forward[index - 1]! + 1;
      let y = x - diagonal;
      while (
        x < beforeLength &&
        y < afterLength &&
        beforeKeys[beforeStart + x] === afterKeys[afterStart + y]
      ) {
        x += 1;
        y += 1;
      }
      forward[index] = x;

      if (oddDelta) {
        const reverseIndex = offset + delta - diagonal;
        if (
          reverseIndex >= 0 &&
          reverseIndex < vectorLength &&
          reverse[reverseIndex]! >= 0 &&
          x + reverse[reverseIndex]! >= beforeLength
        ) {
          return [beforeStart + x, afterStart + y];
        }
      }
    }

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x =
        diagonal === -distance ||
        (diagonal !== distance && reverse[index - 1]! < reverse[index + 1]!)
          ? reverse[index + 1]!
          : reverse[index - 1]! + 1;
      let y = x - diagonal;
      while (
        x < beforeLength &&
        y < afterLength &&
        beforeKeys[beforeEnd - x - 1] === afterKeys[afterEnd - y - 1]
      ) {
        x += 1;
        y += 1;
      }
      reverse[index] = x;

      if (!oddDelta) {
        const forwardDiagonal = delta - diagonal;
        const forwardIndex = offset + forwardDiagonal;
        if (
          forwardIndex >= 0 &&
          forwardIndex < vectorLength &&
          forward[forwardIndex]! >= 0 &&
          forward[forwardIndex]! + x >= beforeLength
        ) {
          const splitX = forward[forwardIndex]!;
          return [beforeStart + splitX, afterStart + splitX - forwardDiagonal];
        }
      }
    }
  }

  throw new Error("Myers diff failed to find a middle split");
}

function appendSingleItemDiff<T>(
  before: readonly T[],
  after: readonly T[],
  beforeKeys: readonly string[],
  afterKeys: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
  steps: DiffStep<T>[],
): void {
  if (beforeEnd - beforeStart === 1) {
    let match = afterStart;
    while (match < afterEnd && afterKeys[match] !== beforeKeys[beforeStart]) match += 1;
    if (match < afterEnd) {
      appendInserts(after, afterStart, match, steps);
      steps.push({ kind: "equal", before: before[beforeStart]!, after: after[match]! });
      appendInserts(after, match + 1, afterEnd, steps);
      return;
    }
  } else {
    let match = beforeStart;
    while (match < beforeEnd && beforeKeys[match] !== afterKeys[afterStart]) match += 1;
    if (match < beforeEnd) {
      appendDeletes(before, beforeStart, match, steps);
      steps.push({ kind: "equal", before: before[match]!, after: after[afterStart]! });
      appendDeletes(before, match + 1, beforeEnd, steps);
      return;
    }
  }
  appendDeletes(before, beforeStart, beforeEnd, steps);
  appendInserts(after, afterStart, afterEnd, steps);
}

function appendDeletes<T>(
  before: readonly T[],
  start: number,
  end: number,
  steps: DiffStep<T>[],
): void {
  for (let index = start; index < end; index += 1)
    steps.push({ kind: "delete", before: before[index]! });
}

function appendInserts<T>(
  after: readonly T[],
  start: number,
  end: number,
  steps: DiffStep<T>[],
): void {
  for (let index = start; index < end; index += 1)
    steps.push({ kind: "insert", after: after[index]! });
}

function coalesceSteps<T>(steps: readonly DiffStep<T>[]): readonly SequenceDiffRun<T>[] {
  const runs: Array<{ kind: SequenceDiffRun<T>["kind"]; before: T[]; after: T[] }> = [];
  for (const step of steps) {
    let run = runs.at(-1);
    if (run?.kind !== step.kind) {
      run = { kind: step.kind, before: [], after: [] };
      runs.push(run);
    }
    if (step.kind === "equal") {
      run.before.push(step.before);
      run.after.push(step.after);
    } else if (step.kind === "delete") {
      run.before.push(step.before);
    } else {
      run.after.push(step.after);
    }
  }
  return runs;
}

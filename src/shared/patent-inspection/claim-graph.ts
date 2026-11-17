export type ClaimFact = Readonly<{
  number: number;
  paragraphId: string;
  paragraphIds: readonly string[];
  paragraphs: readonly Readonly<{ paragraphId: string; text: string }>[];
  text: string;
  kind: "independent" | "dependent";
  subjectName: string | null;
  referencedNumbers: readonly number[];
  multipleDependent: boolean;
  alternativeReference: boolean;
  referenceError?: string;
}>;

export type ClaimGraph = Readonly<{
  byNumber: ReadonlyMap<number, ClaimFact>;
  ancestorsByNumber: ReadonlyMap<number, readonly number[]>;
  multipleDependentNumbers: ReadonlySet<number>;
  cycles: readonly (readonly number[])[];
}>;

export class ClaimGraphInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimGraphInputError";
  }
}

export function buildClaimGraph(claims: readonly ClaimFact[]): ClaimGraph {
  const byNumber = new Map<number, ClaimFact>();
  for (const claim of claims) {
    if (!Number.isSafeInteger(claim.number) || claim.number <= 0) {
      throw new ClaimGraphInputError(`Invalid claim number: ${claim.number}`);
    }
    if (byNumber.has(claim.number)) {
      throw new ClaimGraphInputError(`Duplicate claim number: ${claim.number}`);
    }
    byNumber.set(claim.number, claim);
  }
  const ancestorsByNumber = new Map<number, readonly number[]>();
  const cycleKeys = new Set<string>();
  const cycles: number[][] = [];

  for (const claim of claims) {
    const ancestors: number[] = [];
    const visited = new Set<number>();

    const pending: Array<Readonly<{ number: number; ownerNumber: number }>> =
      claim.referencedNumbers.map((number) => ({ number, ownerNumber: claim.number }));
    let pendingIndex = 0;
    while (pendingIndex < pending.length) {
      const current = pending[pendingIndex];
      pendingIndex += 1;
      if (!current) continue;
      const { number, ownerNumber } = current;
      const parent = byNumber.get(number);
      if (!parent || number >= ownerNumber || visited.has(number)) continue;
      visited.add(number);
      ancestors.push(number);
      for (const referencedNumber of parent.referencedNumbers) {
        pending.push({ number: referencedNumber, ownerNumber: parent.number });
      }
    }
    ancestorsByNumber.set(claim.number, ancestors);
  }

  const state = new Map<number, "unvisited" | "visiting" | "visited">();
  const path: number[] = [];
  const detectCycles = (number: number): void => {
    const currentState = state.get(number) ?? "unvisited";
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      const cycleStart = path.indexOf(number);
      if (cycleStart >= 0) {
        const cycle = canonicalCycle(path.slice(cycleStart));
        const key = cycle.join(",");
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }

    state.set(number, "visiting");
    path.push(number);
    const claim = byNumber.get(number);
    for (const referencedNumber of claim?.referencedNumbers ?? []) {
      if (byNumber.has(referencedNumber)) detectCycles(referencedNumber);
    }
    path.pop();
    state.set(number, "visited");
  };

  for (const claim of claims) detectCycles(claim.number);

  return {
    byNumber,
    ancestorsByNumber,
    multipleDependentNumbers: new Set(
      claims.filter((claim) => claim.multipleDependent).map((claim) => claim.number),
    ),
    cycles: cycles.sort(compareCycles),
  };
}

function canonicalCycle(cycle: readonly number[]): number[] {
  return [...new Set(cycle)].sort((left, right) => left - right);
}

function compareCycles(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

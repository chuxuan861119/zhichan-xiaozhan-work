export type TextEdit = { from: number; to: number; text: string };

/** Bounded character alignment. null lets callers choose a safe fallback. */
export function textEdits(
  original: string,
  revised: string,
  maxCells = 2_000_000,
): TextEdit[] | null {
  const a = Array.from(original),
    b = Array.from(revised);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let aEnd = a.length,
    bEnd = b.length;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (prefix === aEnd && prefix === bEnd) return [];
  const offsets = [0];
  for (const char of a) offsets.push((offsets.at(-1) ?? 0) + char.length);
  const n = aEnd - prefix,
    m = bEnd - prefix;
  if (!n || !m)
    return [
      {
        from: offsets[prefix] ?? 0,
        to: offsets[aEnd] ?? original.length,
        text: b.slice(prefix, bEnd).join(""),
      },
    ];
  if (n * m > maxCells) return null;
  const width = m + 1,
    directions = new Uint8Array((n + 1) * width);
  let previous = new Uint32Array(width);
  for (let i = 1; i <= n; i++) {
    const row = new Uint32Array(width);
    for (let j = 1; j <= m; j++) {
      if (a[prefix + i - 1] === b[prefix + j - 1]) {
        row[j] = (previous[j - 1] ?? 0) + 1;
        directions[i * width + j] = 1;
      } else if ((previous[j] ?? 0) >= (row[j - 1] ?? 0)) {
        row[j] = previous[j] ?? 0;
        directions[i * width + j] = 2;
      } else {
        row[j] = row[j - 1] ?? 0;
        directions[i * width + j] = 3;
      }
    }
    previous = row;
  }
  const steps: Array<{ kind: "equal" | "delete" | "insert"; char: string }> = [];
  let i = n,
    j = m;
  while (i || j) {
    const direction = directions[i * width + j];
    if (i && j && direction === 1) {
      steps.push({ kind: "equal", char: a[prefix + --i] ?? "" });
      j--;
    } else if (i && (!j || direction === 2))
      steps.push({ kind: "delete", char: a[prefix + --i] ?? "" });
    else steps.push({ kind: "insert", char: b[prefix + --j] ?? "" });
  }
  let position = offsets[prefix] ?? 0;
  const edits: TextEdit[] = [];
  let edit: TextEdit | null = null;
  for (const step of steps.reverse()) {
    if (step.kind === "equal") {
      if (edit) {
        edits.push(edit);
        edit = null;
      }
      position += step.char.length;
    } else {
      edit ??= { from: position, to: position, text: "" };
      if (step.kind === "delete") {
        position += step.char.length;
        edit.to = position;
      } else edit.text += step.char;
    }
  }
  if (edit) edits.push(edit);
  return edits;
}

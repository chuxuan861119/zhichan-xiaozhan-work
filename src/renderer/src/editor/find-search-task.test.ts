import { searchPreparedChunks, withReplacementContext } from "./find-replace";
import { startFindSearch } from "./find-search-task";

test("searches every occurrence through the final chunk without a match or text cap", () => {
  const text = "技术 ".repeat(12000) + "末尾技术";
  const chunks = [
    { text, units: [{ start: 0, end: text.length, from: 1, to: text.length + 1, linear: true }] },
    { text: "表格技术", units: [{ start: 0, end: 4, from: 50000, to: 50004, linear: true }] },
  ];
  for (const searchMode of ["literal", "wildcard", "regex"] as const) {
    const result = searchPreparedChunks(chunks, "技术", { searchMode }, undefined, true, false);
    expect(result.error).toBeNull();
    expect(result.matches).toHaveLength(12002);
    expect(result.matches.at(-1)).toMatchObject({ from: 50002, to: 50004 });
    expect(
      result.matches.every((match) => match.prefixText === "" && match.suffixText === ""),
    ).toBe(true);
  }
});

test("cancels an unfinished search without publishing an empty or partial result", () => {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
  const complete = vi.fn();
  const cancel = startFindSearch(
    { chunks: [], query: "a+a+a+a+b", options: {} },
    complete,
    () => worker as unknown as Worker,
  );
  expect(worker.postMessage).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
  cancel();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
});

test("compact worker results preserve captures and replacement prefix/suffix semantics", () => {
  const text = "前技术12 后技术34 末";
  const chunks = [
    { text, units: [{ start: 0, end: text.length, from: 1, to: text.length + 1, linear: true }] },
  ];
  const query = "(?<name>技术)(\\d+)";
  const full = searchPreparedChunks(chunks, query, { searchMode: "regex" });
  const lean = searchPreparedChunks(chunks, query, { searchMode: "regex" }, undefined, true, false);
  const hydrated = withReplacementContext(lean.matches, chunks, "$`-$<name>-$2-$'");
  expect(hydrated.map(({ context: _context, ...match }) => match)).toEqual(full.matches);
  expect(searchPreparedChunks(chunks, "(技术+)+", { searchMode: "regex" }).matches).toHaveLength(2);
});

test("publishes every match only after completion and ignores a late cancelled response", () => {
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
  };
  const complete = vi.fn();
  const cancel = startFindSearch(
    { chunks: [], query: "技术", options: {} },
    complete,
    () => worker as unknown as Worker,
  );
  const deliver = worker.onmessage!;
  const result = {
    matches: Array.from({ length: 12000 }, (_, i) => ({ from: i * 2, to: i * 2 + 2 })),
    error: null,
  };
  deliver({ data: result } as MessageEvent);
  expect(complete).toHaveBeenCalledWith(result);
  cancel();
  deliver({ data: result } as MessageEvent);
  expect(complete).toHaveBeenCalledOnce();
});

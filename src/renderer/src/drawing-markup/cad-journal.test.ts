import { expect, test, vi } from "vitest";
import { CadJournal } from "./cad-journal";

test("append-only snapshots load their source once and replay each command once", () => {
  const kernel = { load_dxf: vi.fn(), execute: vi.fn(), paste_dxf: vi.fn() };
  const journal = new CadJournal(kernel);
  const a = {
    source: new Uint8Array([1]),
    sourceId: "source-a",
    edits: [{ command: "line", params: { x: 1 } }],
  };
  journal.load(a);
  journal.load(structuredClone(a));
  journal.load({ ...a, edits: [...a.edits, { command: "circle", params: { r: 2 } }] });
  expect(kernel.load_dxf).toHaveBeenCalledTimes(1);
  expect(kernel.execute.mock.calls.map((c) => c[0])).toEqual(["line", "circle"]);
});

test("undo, branching and failed replay never inherit the newest drawing", () => {
  const kernel = { load_dxf: vi.fn(), execute: vi.fn(), paste_dxf: vi.fn() };
  const journal = new CadJournal(kernel);
  const a = { source: new Uint8Array([1]), edits: [{ command: "line", params: { x: 1 } }] };
  journal.load(a);
  journal.load({ ...a, edits: [] });
  kernel.execute.mockImplementationOnce(() => {
    throw new Error("failed");
  });
  expect(() => journal.load(a)).toThrow("failed");
  journal.load(a);
  expect(kernel.load_dxf).toHaveBeenCalledTimes(3);
  expect(journal.snapshot()).toEqual(a);
});

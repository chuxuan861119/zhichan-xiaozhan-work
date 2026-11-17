import { expect, test } from "vitest";
import { cadSemanticKey, cadSemanticKeyMatches } from "./cad-semantic-key.js";
import type { DrawingProject } from "./model.js";
test("opening existing labels does not request a stroke migration", () => {
  const p = { annotations: [{ id: "a" }], cad: {} } as unknown as DrawingProject;
  expect(cadSemanticKey(p)).toBe("e9a2224d95e2cd28");
});
test("compatible saved keys do not migrate labels but real edits still invalidate them", () => {
  const p = { annotations: [{ id: "a" }], cad: {} } as unknown as DrawingProject;
  for (const saved of ["e9a2224d95e2cd28", "be397b361e363deb", "be437b361e3e9270"]) {
    p.cad!.semanticKey = saved;
    expect(cadSemanticKeyMatches(p)).toBe(true);
    p.annotations[0]!.id = "changed";
    expect(cadSemanticKeyMatches(p)).toBe(false);
    p.annotations[0]!.id = "a";
  }
  p.cad!.semanticKey = "stale";
  expect(cadSemanticKeyMatches(p)).toBe(false);
});
test("special appearance invalidates semantic cache but regenerated handles do not", () => {
  const p = {
    annotations: [],
    cad: {
      objects: [
        { id: "a", kind: "label", label: ["A"], appearance: { label: { color: "#ff0000" } } },
      ],
    },
  } as unknown as DrawingProject;
  const key = cadSemanticKey(p);
  p.cad!.objects![0]!.label = ["B"];
  expect(cadSemanticKey(p)).toBe(key);
  p.cad!.objects![0]!.appearance!.label!.color = "#0000ff";
  expect(cadSemanticKey(p)).not.toBe(key);
});

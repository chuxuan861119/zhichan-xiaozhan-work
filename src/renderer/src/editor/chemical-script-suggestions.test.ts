import { suggestChemicalScripts } from "./chemical-script-suggestions";

function context(fragment: string) {
  return {
    fragment,
    range: [4, 4 + fragment.length] as [number, number],
    sourceVersion: `prefix:${fragment}`,
  };
}

describe("chemical script suggestions", () => {
  test.each([
    ["H2", ["H₂"]],
    ["H2O", ["H₂O"]],
    ["Ca(OH)2", ["Ca(OH)₂"]],
    ["2H2O", ["2H₂O"]],
    ["Fe3+", ["Fe³⁺"]],
    ["NH4+", ["NH₄⁺"]],
    ["SO4^2-", ["SO₄²⁻"]],
    ["^14C", ["¹⁴C"]],
  ])("suggests scripts for %s", (fragment, expected) => {
    expect(suggestChemicalScripts(context(fragment)).map((item) => item.displayText)).toEqual(
      expected,
    );
  });

  test("returns two distinct candidates for ambiguous charge text", () => {
    const candidates = suggestChemicalScripts(context("SO42-"));

    expect(candidates.map((item) => item.displayText)).toEqual(["SO₄²⁻", "SO₄₂⁻"]);
    expect(new Set(candidates.map((item) => item.latex)).size).toBe(candidates.length);
  });

  test("offers a two-letter element when uppercase input is chemically ambiguous", () => {
    expect(suggestChemicalScripts(context("CO")).map((item) => item.displayText)).toEqual(["Co"]);
  });

  test("keeps formula formatting first and adds the ambiguous element spelling second", () => {
    expect(suggestChemicalScripts(context("CO2")).map((item) => item.displayText)).toEqual([
      "CO₂",
      "Co₂",
    ]);
  });

  test.each(["14C", "H_{2}O", "MnO2(s)", "25C", "not chemistry", "Xx2", "Ca(OH2"])(
    "does not make an unsafe suggestion for %s",
    (fragment) => {
      expect(suggestChemicalScripts(context(fragment))).toEqual([]);
    },
  );

  test("preserves the source range and version on every candidate", () => {
    expect(suggestChemicalScripts(context("H2O"))[0]).toMatchObject({
      fragment: "H2O",
      range: [4, 7],
      sourceVersion: "prefix:H2O",
    });
  });
});

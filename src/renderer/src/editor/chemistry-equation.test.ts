import {
  MAX_CHEMICAL_EQUATION_BYTES,
  normalizeChemicalEquation,
  unwrapChemicalEquation,
} from "./chemistry-equation";

describe("chemical equation normalization", () => {
  test.each([String.raw`A \xrightarrow{\text{\{}} B`, String.raw`A \xrightarrow{\text{\}}} B`])(
    "preserves escaped braces in a valid condition: %s",
    (body) => {
      const source = String.raw`\ce{${body}}`;
      expect(normalizeChemicalEquation(source)).toEqual({ ok: true, value: source });
      expect(unwrapChemicalEquation(source)).toBe(body);
    },
  );
  test("wraps a plain chemical equation in one ce command", () => {
    expect(normalizeChemicalEquation("SO4^2- + Ba^2+ -> BaSO4 v")).toEqual({
      ok: true,
      value: String.raw`\ce{SO4^2- + Ba^2+ -> BaSO4 v}`,
    });
  });

  test("keeps an existing single ce command", () => {
    expect(normalizeChemicalEquation(String.raw`\ce{H2O}`)).toEqual({
      ok: true,
      value: String.raw`\ce{H2O}`,
    });
  });

  test("rejects empty input with a stable error code", () => {
    expect(normalizeChemicalEquation(" \n\t ")).toMatchObject({
      ok: false,
      error: { code: "CHEMICAL_EQUATION_EMPTY" },
    });
  });

  test.each([String.raw`\ce{}`, String.raw`\ce{   }`])(
    "rejects an empty ce body in %s with the empty error code",
    (source) => {
      expect(normalizeChemicalEquation(source)).toMatchObject({
        ok: false,
        error: { code: "CHEMICAL_EQUATION_EMPTY" },
      });
    },
  );

  test("normalizes whitespace between the ce command and its opening brace", () => {
    expect(normalizeChemicalEquation(String.raw`\ce {H2O}`)).toEqual({
      ok: true,
      value: String.raw`\ce{H2O}`,
    });
  });

  test("rejects nested ce commands with a stable error code", () => {
    expect(normalizeChemicalEquation(String.raw`\ce{Na+ + \ce{Cl-}}`)).toMatchObject({
      ok: false,
      error: { code: "CHEMICAL_EQUATION_NESTED_CE" },
    });
  });

  test("rejects malformed chemical source with a stable error code", () => {
    expect(normalizeChemicalEquation(String.raw`\ce{H2O`)).toMatchObject({
      ok: false,
      error: { code: "CHEMICAL_EQUATION_INVALID_SYNTAX" },
    });
  });

  test("accepts a wrapped equation exactly at the 64 KiB UTF-8 limit", () => {
    const body = `H2${" ".repeat(
      MAX_CHEMICAL_EQUATION_BYTES - String.raw`\ce{}`.length - "H2O2".length,
    )}O2`;
    const result = normalizeChemicalEquation(body);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(new TextEncoder().encode(result.value).byteLength).toBe(MAX_CHEMICAL_EQUATION_BYTES);
    }
  });

  test("rejects a wrapped equation one byte above the 64 KiB UTF-8 limit", () => {
    const body = `H2${" ".repeat(
      MAX_CHEMICAL_EQUATION_BYTES - String.raw`\ce{}`.length - "H2O2".length + 1,
    )}O2`;

    expect(normalizeChemicalEquation(body)).toMatchObject({
      ok: false,
      error: { code: "CHEMICAL_EQUATION_TOO_LARGE" },
    });
  });

  test("trims external whitespace before checking the normalized UTF-8 size", () => {
    const externalWhitespace = "　".repeat(MAX_CHEMICAL_EQUATION_BYTES);

    expect(normalizeChemicalEquation(`${externalWhitespace}H2${externalWhitespace}`)).toEqual({
      ok: true,
      value: String.raw`\ce{H2}`,
    });
  });

  test("does not mistake the legal centerdot command for a nested ce command", () => {
    expect(normalizeChemicalEquation(String.raw`H2 \centerdot O2`)).toEqual({
      ok: true,
      value: String.raw`\ce{H2 \centerdot O2}`,
    });
  });

  test("rejects a nested ce command separated from its argument by whitespace", () => {
    expect(normalizeChemicalEquation(String.raw`\ce{Na+ + \ce {Cl-}}`)).toMatchObject({
      ok: false,
      error: { code: "CHEMICAL_EQUATION_NESTED_CE" },
    });
  });

  test("accepts LaTeX \\xrightarrow with Chinese text inside a ce wrapper", () => {
    expect(normalizeChemicalEquation(String.raw`H_{2}\xrightarrow{加热}H_{2}O`)).toMatchObject({
      ok: true,
      value: String.raw`\ce{H_{2}\xrightarrow{加热}H_{2}O}`,
    });
  });

  test("accepts LaTeX \\xrightarrow that was already ce-wrapped", () => {
    expect(normalizeChemicalEquation(String.raw`\ce{H_{2}\xrightarrow{催化剂}}`)).toMatchObject({
      ok: true,
      value: String.raw`\ce{H_{2}\xrightarrow{催化剂}}`,
    });
  });

  test.each([
    String.raw`H_{2}\xrightarrow{浓 H_{2}SO_{4}}H_{2}O`,
    String.raw`H_{2}\xrightarrow{\text{浓 }H_{2}SO_{4}}H_{2}O`,
  ])("accepts a Chinese condition mixed with LaTeX subscripts: %s", (source) => {
    expect(normalizeChemicalEquation(source)).toEqual({
      ok: true,
      value: String.raw`\ce{${source}}`,
    });
  });
});

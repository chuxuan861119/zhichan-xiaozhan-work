import { describe, expect, test } from "vitest";
import {
  cmToMm,
  formatCmInput,
  mmToCm,
  pageMarginsFromCmInput,
  parseCmInput,
} from "./page-margin-utils";

describe("mmToCm / cmToMm", () => {
  test("converts Word defaults between mm and cm without float noise", () => {
    expect(mmToCm(25.4)).toBe(2.54);
    expect(mmToCm(31.7)).toBe(3.17);
    expect(cmToMm(2.54)).toBe(25.4);
    expect(cmToMm(3.17)).toBe(31.7);
  });

  test("round trips through the boundary values", () => {
    for (const cm of [0, 0.1, 1.27, 2.54, 3.17, 5]) {
      expect(mmToCm(cmToMm(cm))).toBe(cm);
    }
  });

  test("keeps two decimal places", () => {
    expect(cmToMm(2.543)).toBe(25.43);
    expect(mmToCm(25.439)).toBe(2.54);
  });
});

describe("formatCmInput", () => {
  test("formats to two decimal places", () => {
    expect(formatCmInput(2.54)).toBe("2.54");
    expect(formatCmInput(3.1)).toBe("3.10");
    expect(formatCmInput(0)).toBe("0.00");
    expect(formatCmInput(5)).toBe("5.00");
  });
});

describe("parseCmInput", () => {
  test("parses plain decimal input", () => {
    expect(parseCmInput("2.54")).toBe(2.54);
    expect(parseCmInput(" 2.5 ")).toBe(2.5);
  });

  test("allows negative numbers so the caller can give field-level errors", () => {
    expect(parseCmInput("-1")).toBe(-1);
  });
});

describe("pageMarginsFromCmInput", () => {
  const validInput = { top: "2.54", right: "3.17", bottom: "2.54", left: "3.17" };

  test("builds mm margins from valid cm input", () => {
    const result = pageMarginsFromCmInput(validInput);
    expect(result.margins).toEqual({
      marginTopMm: 25.4,
      marginRightMm: 31.7,
      marginBottomMm: 25.4,
      marginLeftMm: 31.7,
    });
    expect(result.fieldErrors).toEqual({ top: null, right: null, bottom: null, left: null });
  });

  test("flags an empty field as invalid input", () => {
    const result = pageMarginsFromCmInput({ ...validInput, top: "" });
    expect(result.margins).toBeNull();
    expect(result.fieldErrors.top).toMatch(/有效数字/u);
  });

  test("accepts the Word wide preset's 5.08cm side margins", () => {
    const result = pageMarginsFromCmInput({ ...validInput, left: "5.08", right: "5.08" });
    expect(result.margins).toEqual({
      marginTopMm: 25.4,
      marginRightMm: 50.8,
      marginBottomMm: 25.4,
      marginLeftMm: 50.8,
    });
    expect(result.fieldErrors).toEqual({ top: null, right: null, bottom: null, left: null });
  });

  test("flags a single side above 6cm as exceeding 60mm", () => {
    const result = pageMarginsFromCmInput({ ...validInput, left: "6.01" });
    expect(result.margins).toBeNull();
    expect(result.fieldErrors.left).toMatch(/不能超过 60mm/u);
  });

  test("flags a negative side as below 0mm", () => {
    const result = pageMarginsFromCmInput({ ...validInput, bottom: "-0.1" });
    expect(result.margins).toBeNull();
    expect(result.fieldErrors.bottom).toMatch(/不能小于 0mm/u);
  });

  test("flags every invalid field and keeps valid fields null", () => {
    const result = pageMarginsFromCmInput({ top: "abc", right: "3.17", bottom: "9", left: "-2" });
    expect(result.margins).toBeNull();
    expect(result.fieldErrors.top).toMatch(/有效数字/u);
    expect(result.fieldErrors.right).toBeNull();
    expect(result.fieldErrors.bottom).toMatch(/不能超过 60mm/u);
    expect(result.fieldErrors.left).toMatch(/不能小于 0mm/u);
  });

  test("accepts exactly 6.00cm (60mm) per side", () => {
    const result = pageMarginsFromCmInput({ top: "6", right: "6", bottom: "6", left: "6" });
    expect(result.margins).toEqual({
      marginTopMm: 60,
      marginRightMm: 60,
      marginBottomMm: 60,
      marginLeftMm: 60,
    });
    expect(result.fieldErrors).toEqual({ top: null, right: null, bottom: null, left: null });
  });
});

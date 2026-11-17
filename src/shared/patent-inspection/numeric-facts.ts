import type { PatentLocation } from "./types.js";

export type NumericFactKind = "range" | "percentage" | "quantity-mapping";

export type NumericFact = Readonly<{
  kind: NumericFactKind;
  location: PatentLocation;
  raw: string;
  lower: number | null;
  upper: number | null;
  lowerUnit: string | null;
  upperUnit: string | null;
  value: number | null;
  unit: string | null;
}>;

const NUMBER = "(-?\\d+(?:\\.\\d+)?)";
const UNIT =
  "(℃|°C|kHz|kPa|MPa|mV|mA|mm|cm|μm|nm|mg|kg|ms|min|毫米|厘米|微米|纳米|毫克|千克|毫秒|分钟|小时|Pa|Hz|米|克|K|V|A|m|g|s|h|秒|°|度)";
const RANGE_LABEL = "(下限|上限|最小(?:值|量)?|最大(?:值|量)?|最低|最高)";

export function extractNumericFacts(
  text: string,
  location: PatentLocation,
): readonly NumericFact[] {
  const facts: NumericFact[] = [];
  const occupied: Array<{ start: number; end: number }> = [];

  const rangePattern = new RegExp(
    `${RANGE_LABEL}\\s*(?:为|是|可为|达到)?\\s*${NUMBER}\\s*${UNIT}?\\s*[，,、;；和及至到\\s]{0,16}${RANGE_LABEL}\\s*(?:为|是|可为|达到)?\\s*${NUMBER}\\s*${UNIT}?`,
    "gu",
  );
  for (const match of text.matchAll(rangePattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const firstLabel = match[1] ?? "";
    const firstNumber = Number(match[2]);
    const firstUnit = match[3] ?? null;
    const secondLabel = match[4] ?? "";
    const secondNumber = Number(match[5]);
    const secondUnit = match[6] ?? null;
    const lowerIsFirst = isLowerLabel(firstLabel);
    const upperIsFirst = isUpperLabel(firstLabel);
    const lowerIsSecond = isLowerLabel(secondLabel);
    const upperIsSecond = isUpperLabel(secondLabel);
    if ((!lowerIsFirst && !upperIsFirst) || (!lowerIsSecond && !upperIsSecond)) continue;
    addRange(
      facts,
      occupied,
      location,
      start,
      raw,
      lowerIsFirst ? firstNumber : lowerIsSecond ? secondNumber : null,
      upperIsFirst ? firstNumber : upperIsSecond ? secondNumber : null,
      lowerIsFirst ? firstUnit : lowerIsSecond ? secondUnit : null,
      upperIsFirst ? firstUnit : upperIsSecond ? secondUnit : null,
    );
  }

  const directRangePattern = new RegExp(
    `${NUMBER}\\s*${UNIT}?\\s*(?:至|到|～|~|—|－|-)\\s*${NUMBER}\\s*${UNIT}?`,
    "gu",
  );
  for (const match of text.matchAll(directRangePattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    if (occupied.some((span) => start < span.end && start + raw.length > span.start)) continue;
    const prefix = text.slice(Math.max(0, start - 8), start);
    if (/[由从降升变]\s*$/u.test(prefix)) continue;
    addRange(
      facts,
      occupied,
      location,
      start,
      raw,
      Number(match[1]),
      Number(match[3]),
      match[2] ?? null,
      match[4] ?? null,
    );
  }

  for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)\s*[%％]/gu)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    facts.push({
      kind: "percentage",
      location: locationWithOffset(location, start, start + raw.length),
      raw,
      lower: null,
      upper: null,
      lowerUnit: null,
      upperUnit: null,
      value: Number(match[1]),
      unit: "%",
    });
    occupied.push({ start, end: start + raw.length });
  }

  const quantityPattern = new RegExp(
    `([A-Za-z\\p{Script=Han}][A-Za-z0-9_\\p{Script=Han}]*)\\s*(?:为|是|包括|含有|占)\\s*${NUMBER}\\s*${UNIT}?`,
    "gu",
  );
  for (const match of text.matchAll(quantityPattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (occupied.some((span) => start < span.end && end > span.start)) continue;
    const value = Number(match[2]);
    const unit = match[3] ?? null;
    facts.push({
      kind: "quantity-mapping",
      location: locationWithOffset(location, start, end),
      raw,
      lower: null,
      upper: null,
      lowerUnit: null,
      upperUnit: null,
      value,
      unit,
    });
    occupied.push({ start, end });
  }

  for (const match of text.matchAll(new RegExp(`${NUMBER}\\s*${UNIT}`, "gu"))) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (occupied.some((span) => start < span.end && end > span.start)) continue;
    facts.push({
      kind: "quantity-mapping",
      location: locationWithOffset(location, start, end),
      raw,
      lower: null,
      upper: null,
      lowerUnit: null,
      upperUnit: null,
      value: Number(match[1]),
      unit: match[2] ?? null,
    });
  }

  return facts;
}

function addRange(
  facts: NumericFact[],
  occupied: Array<{ start: number; end: number }>,
  location: PatentLocation,
  start: number,
  raw: string,
  lower: number | null,
  upper: number | null,
  lowerUnit: string | null,
  upperUnit: string | null,
): void {
  if (lower === null || upper === null) return;
  facts.push({
    kind: "range",
    location: locationWithOffset(location, start, start + raw.length),
    raw,
    lower,
    upper,
    lowerUnit,
    upperUnit,
    value: null,
    unit: lowerUnit ?? upperUnit,
  });
  occupied.push({ start, end: start + raw.length });
}

function isLowerLabel(label: string): boolean {
  return /^(?:下限|最小(?:值|量)?|最低)$/u.test(label);
}

function isUpperLabel(label: string): boolean {
  return /^(?:上限|最大(?:值|量)?|最高)$/u.test(label);
}

function locationWithOffset(location: PatentLocation, start: number, end: number): PatentLocation {
  return {
    ...location,
    startOffset: (location.startOffset ?? 0) + start,
    endOffset: (location.startOffset ?? 0) + end,
  };
}

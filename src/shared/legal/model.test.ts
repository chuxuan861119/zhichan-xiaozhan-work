import { expect, test } from "vitest";
import { type AgreementRecord, agreementDecision } from "./model.js";

const policy = { termsVersion: "terms-1", privacyVersion: "privacy-1", operator: "", contact: "" };
const record: AgreementRecord = {
  schemaVersion: 1,
  appVersion: "1.1.1",
  ...policy,
  statisticsNoticeVersion: "usage-1",
  everStatisticsConsent: false,
};
test("first use shows agreements and independent statistics", () => {
  expect(agreementDecision(null, "1.1.1", policy, "usage-1", false)).toEqual({
    needsConfirmation: true,
    reason: "first-use",
    showStatistics: true,
  });
});
test("same software version does not repeatedly prompt a user who declined statistics", () => {
  expect(agreementDecision(record, "1.1.1", policy, "usage-1", false).needsConfirmation).toBe(
    false,
  );
  expect(agreementDecision(record, "1.1.2", policy, "usage-1", false)).toEqual({
    needsConfirmation: true,
    reason: "software-update",
    showStatistics: true,
  });
});
test("consent history skips software updates and hides statistics on agreement-only changes", () => {
  const accepted = { ...record, everStatisticsConsent: true };
  expect(agreementDecision(accepted, "1.1.2", policy, "usage-1", false).needsConfirmation).toBe(
    false,
  );
  expect(
    agreementDecision(
      accepted,
      "1.1.2",
      { ...policy, privacyVersion: "privacy-2" },
      "usage-1",
      false,
    ),
  ).toEqual({ needsConfirmation: true, reason: "policy-update", showStatistics: false });
});
test("changed statistics processing requires fresh choice despite consent history", () => {
  expect(
    agreementDecision(
      { ...record, everStatisticsConsent: true },
      "1.1.1",
      policy,
      "usage-2",
      false,
    ),
  ).toEqual({ needsConfirmation: true, reason: "policy-update", showStatistics: true });
});
test("legacy statistics consent is preserved without bypassing first agreement confirmation", () => {
  expect(agreementDecision(null, "1.1.1", policy, "usage-1", true)).toEqual({
    needsConfirmation: true,
    reason: "first-use",
    showStatistics: false,
  });
});

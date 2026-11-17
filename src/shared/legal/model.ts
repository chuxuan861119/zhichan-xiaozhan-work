import { z } from "zod";
import { UsageStateSchema } from "../usage-statistics/model.js";

const VersionSchema = z.string().trim().min(1).max(80);
export const LegalPolicySchema = z
  .object({
    termsVersion: VersionSchema,
    privacyVersion: VersionSchema,
    operator: z.string().trim().max(200),
    contact: z.string().trim().max(300),
  })
  .strict();
export type LegalPolicy = z.infer<typeof LegalPolicySchema>;
export const AgreementRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    appVersion: VersionSchema,
    termsVersion: VersionSchema,
    privacyVersion: VersionSchema,
    statisticsNoticeVersion: VersionSchema.nullable(),
    everStatisticsConsent: z.boolean(),
  })
  .strict();
export type AgreementRecord = z.infer<typeof AgreementRecordSchema>;
export const AgreementStateSchema = z
  .object({
    appVersion: VersionSchema,
    policy: LegalPolicySchema,
    needsConfirmation: z.boolean(),
    reason: z.enum(["first-use", "software-update", "policy-update", "none"]),
    showStatistics: z.boolean(),
    statistics: UsageStateSchema.nullable(),
  })
  .strict();
export type AgreementState = z.infer<typeof AgreementStateSchema>;
export const AgreementAcceptSchema = z
  .object({
    appVersion: VersionSchema,
    termsVersion: VersionSchema,
    privacyVersion: VersionSchema,
    participate: z.boolean().optional(),
    statisticsNoticeVersion: VersionSchema.optional(),
  })
  .strict();
export type AgreementAccept = z.infer<typeof AgreementAcceptSchema>;
export function agreementDecision(
  record: AgreementRecord | null,
  appVersion: string,
  policy: LegalPolicy,
  statisticsNoticeVersion: string | null,
  legacyConsent: boolean,
) {
  const everConsented = record?.everStatisticsConsent || legacyConsent;
  const statisticsChanged = Boolean(
    record && everConsented && record.statisticsNoticeVersion !== statisticsNoticeVersion,
  );
  const policyChanged = Boolean(
    record &&
      (record.termsVersion !== policy.termsVersion ||
        record.privacyVersion !== policy.privacyVersion ||
        statisticsChanged),
  );
  const reason: AgreementState["reason"] = !record
    ? "first-use"
    : policyChanged
      ? "policy-update"
      : !everConsented && record.appVersion !== appVersion
        ? "software-update"
        : "none";
  return {
    needsConfirmation: reason !== "none",
    reason,
    showStatistics: !everConsented || statisticsChanged,
  };
}

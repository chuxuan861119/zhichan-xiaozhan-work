import { z } from "zod";

// No model names, endpoints, document identifiers, response text or credentials.
export const CorrectionResponseDiagnosticSchema = z.object({
  attempt: z.number().int().min(1).max(2),
  finishReason: z.enum(["stop", "length", "content_filter", "tool_calls", "missing", "other"]),
  reasoningCharacters: z.number().int().nonnegative(),
  contentCharacters: z.number().int().nonnegative(),
  streamCompleted: z.boolean(),
});

export type CorrectionResponseDiagnostic = z.infer<typeof CorrectionResponseDiagnosticSchema>;

export function diagnosticFinishReason(
  value: string | null | undefined,
): CorrectionResponseDiagnostic["finishReason"] {
  if (!value) return "missing";
  return value === "stop" ||
    value === "length" ||
    value === "content_filter" ||
    value === "tool_calls"
    ? value
    : "other";
}

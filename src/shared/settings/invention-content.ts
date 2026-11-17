import { z } from "zod";

export const DEFAULT_INVENTION_CONTENT_PREFIX = "作为优化，";
export const INVENTION_CONTENT_PREFIXES = [
  DEFAULT_INVENTION_CONTENT_PREFIX,
  "进一步地，",
  "优选地，",
  "可选地，",
] as const;
export const InventionContentPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\r\n\u2028\u2029]+$/u);

export function normalizeInventionContentPrefix(value: string): string {
  const text = value.trim();
  return text && !/[，,：:；;。.!！?？]$/u.test(text) ? `${text}，` : text;
}

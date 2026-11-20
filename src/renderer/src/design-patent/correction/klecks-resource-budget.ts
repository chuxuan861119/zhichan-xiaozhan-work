export type KlecksResourcePolicy = {
  limitBytes: number;
  baselineBytes: number;
  retainedMultiplier: number;
};
export const KLECKS_RESOURCE_LIMIT_MESSAGE =
  "本次操作预计超出编辑器资源预算，操作未执行，当前图片和编辑状态未被清除。";
export function isKlecksResourceLimit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EDITOR_RESOURCE_LIMIT"
  );
}
/** An admission estimate, not measured RSS or a guarantee against OS memory pressure. */
export const DEFAULT_KLECKS_RESOURCE_POLICY: Readonly<KlecksResourcePolicy> = Object.freeze({
  limitBytes: 2 * 1024 ** 3,
  baselineBytes: 256 * 1024 ** 2,
  // The resident counter already includes history, layers and compositor canvases.
  // Keep 50% overhead here; each operation separately reserves its working copies.
  retainedMultiplier: 1.5,
});
export function grantedKlecksResourcePolicy(limitBytes: number): KlecksResourcePolicy {
  if (
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < 512 * 1024 ** 2 ||
    limitBytes > DEFAULT_KLECKS_RESOURCE_POLICY.limitBytes
  )
    throw new Error("图片编辑器资源配额无效。");
  return { ...DEFAULT_KLECKS_RESOURCE_POLICY, limitBytes };
}
export class KlecksResourceBudget {
  private reservations = 0;
  private readonly policy: KlecksResourcePolicy;
  constructor(
    private readonly retainedBytes: () => number,
    policy: KlecksResourcePolicy = DEFAULT_KLECKS_RESOURCE_POLICY,
  ) {
    this.policy = { ...policy };
    if (
      !Number.isSafeInteger(policy.limitBytes) ||
      policy.limitBytes <= 0 ||
      !Number.isSafeInteger(policy.baselineBytes) ||
      policy.baselineBytes < 0 ||
      !Number.isFinite(policy.retainedMultiplier) ||
      policy.retainedMultiplier < 1
    )
      throw new Error("编辑器资源预算配置无效。");
  }
  estimate(): number {
    const retained = this.retainedBytes();
    if (!Number.isSafeInteger(retained) || retained < 0)
      throw new Error("无法确认编辑器资源占用。");
    return (
      this.policy.baselineBytes + retained * this.policy.retainedMultiplier + this.reservations
    );
  }
  reserve(additionalEstimatedBytes: number): () => void {
    if (
      !Number.isSafeInteger(additionalEstimatedBytes) ||
      additionalEstimatedBytes < 0 ||
      this.estimate() + additionalEstimatedBytes > this.policy.limitBytes
    ) {
      throw Object.assign(new Error(KLECKS_RESOURCE_LIMIT_MESSAGE), {
        code: "EDITOR_RESOURCE_LIMIT",
      });
    }
    this.reservations += additionalEstimatedBytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.reservations -= additionalEstimatedBytes;
      }
    };
  }
}

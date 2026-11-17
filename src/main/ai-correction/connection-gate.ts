import { isNetworkAiAvailable } from "../../shared/platform.js";

/** Checks each request, including follow-up batches, and cancels in-flight transport on disable. */
export class AiConnectionGate {
  private readonly active = new Set<AbortController>();
  private generation = 0;
  constructor(
    private readonly enabled: () => Promise<boolean>,
    private readonly platform: string = process.platform,
  ) {}

  cancelAll() {
    this.generation += 1;
    for (const controller of this.active) controller.abort();
  }

  async run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (
      !isNetworkAiAvailable(this.platform) ||
      !(await this.enabled()) ||
      generation !== this.generation
    ) {
      throw Object.assign(
        new Error(
          isNetworkAiAvailable(this.platform)
            ? "AI 连接已关闭，请在设置的 AI 使用与隐私中开启。"
            : "鸿蒙首发版本暂未开放联网 AI 功能。",
        ),
        {
          code: "AI_DISABLED",
        },
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.active.add(controller);
    try {
      controller.signal.throwIfAborted();
      return await operation(controller.signal);
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_TONE,
  type ToneOptions,
  ToneOptionsSchema,
  type ToneState,
} from "../../../../shared/settings/design-tone";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksToolCommand } from "./klecks-tool-port";
export function KlecksToneDialog({
  state,
  frame,
  send,
}: {
  state: ToneState;
  frame: KlecksFrameClient;
  send(c: KlecksToolCommand): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    identity = useRef(frame.state.snapshot()?.identity);
  const [options, setOptions] = useState(state.options),
    [draft, setDraft] = useState<Record<string, string>>(() =>
      Object.fromEntries(Object.entries(state.options).map(([k, v]) => [k, String(v)])),
    );
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (identity.current)
        void frame.tools.send(identity.current, { action: "focus" }).catch(() => {});
    };
  }, [frame]);
  const parse = (o: ToneOptions, d: Record<string, string>) =>
    ToneOptionsSchema.refine(
      (v) => Math.abs(v.gamma * 100 - Math.round(v.gamma * 100)) < 1e-7,
    ).safeParse({
      ...o,
      ...Object.fromEntries(
        ["black", "white", "gamma", "outBlack", "outWhite", "threshold"].map((k) => [
          k,
          d[k]?.trim() ? Number(d[k]) : NaN,
        ]),
      ),
    });
  const parsed = parse(options, draft),
    current = parsed.success && JSON.stringify(parsed.data) === JSON.stringify(state.options);
  const update = (o: ToneOptions, d = draft) => {
    setOptions(o);
    setDraft(d);
    const p = parse(o, d);
    if (p.success) send({ action: "tone", operation: "options", options: p.data });
  };
  const numeric = (
    k: "black" | "white" | "gamma" | "outBlack" | "outWhite" | "threshold",
    label: string,
  ) => {
    const gamma = k === "gamma",
      min = gamma ? 0.1 : 0,
      max = gamma ? 9.99 : 255,
      step = gamma ? 0.01 : 1;
    return (
      <label key={k}>
        {label}
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            aria-label={label + "滑块"}
            type="range"
            min={min}
            max={max}
            step={step}
            disabled={state.applying}
            value={Number(draft[k]) || min}
            onChange={(e) => update(options, { ...draft, [k]: e.currentTarget.value })}
          />
          <input
            aria-label={label}
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft[k]}
            disabled={state.applying}
            onChange={(e) => update(options, { ...draft, [k]: e.currentTarget.value })}
          />
        </span>
      </label>
    );
  };
  const cancel = () => send({ action: "tone", operation: "cancel" }),
    peak = Math.max(1, ...state.histogram);
  return createPortal(
    <dialog
      className="klecks-size-dialog klecks-whitespace-dialog klecks-tone-dialog"
      aria-label="色阶与阈值"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (current && state.canApply && !state.busy)
            send({ action: "tone", operation: "apply" });
        }}
      >
        <h2>色阶与阈值</h2>
        <div className="klecks-whitespace-dialog__body">
          <p>
            仅调整当前图层；有选区时只调整选区内颜色，保留透明度及其他图层。预览显示当前图层，不是所有图层的合成图。
          </p>
          <label>
            调整方式
            <select
              aria-label="调整方式"
              value={options.mode}
              disabled={state.applying}
              onChange={(e) => {
                const next = {
                  ...(parsed.success ? parsed.data : state.options),
                  mode: e.currentTarget.value as ToneOptions["mode"],
                };
                update(
                  next,
                  Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])),
                );
              }}
            >
              <option value="levels">色阶</option>
              <option value="threshold">阈值（黑白二值化）</option>
            </select>
          </label>
          {options.mode === "levels" && (
            <label>
              通道
              <select
                aria-label="色阶通道"
                value={options.channel}
                disabled={state.applying}
                onChange={(e) =>
                  update({ ...options, channel: e.currentTarget.value as ToneOptions["channel"] })
                }
              >
                {[
                  ["rgb", "RGB"],
                  ["r", "红"],
                  ["g", "绿"],
                  ["b", "蓝"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <svg
            role="img"
            aria-label="原图选区直方图"
            viewBox="0 0 256 64"
            style={{ width: "100%", height: 70, background: "#f1f5f9" }}
          >
            {state.histogram.map((n, i) => (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: The index is the fixed intensity bin.
                key={i}
                x={i}
                y={64 - (n / peak) * 64}
                width={1}
                height={(n / peak) * 64}
                fill="#176f65"
              />
            ))}
          </svg>
          {options.mode === "levels" ? (
            <>
              {numeric("black", "输入黑点")}
              {numeric("gamma", "中间调（Gamma）")}
              {numeric("white", "输入白点")}
              {numeric("outBlack", "输出黑点")}
              {numeric("outWhite", "输出白点")}
            </>
          ) : (
            <>
              {numeric("threshold", "阈值")}
              <p>低于阈值变为黑色，其余变为白色。可能损失浅色细节，请核对预览。</p>
            </>
          )}
          <button
            type="button"
            disabled={state.applying}
            onClick={() => {
              const o = { ...DEFAULT_TONE, mode: options.mode };
              update(o, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])));
            }}
          >
            重置参数
          </button>
          <div className="klecks-whitespace-dialog__previews">
            {[
              ["处理前", state.before],
              ["处理后", current && !state.busy ? state.after : null],
            ].map(([label, url]) => (
              <figure key={label}>
                <figcaption>{label}</figcaption>
                <div>
                  {url ? (
                    <img src={url} alt={label ?? ""} />
                  ) : (
                    <span>{state.busy ? "正在计算…" : "暂无有效预览"}</span>
                  )}
                </div>
              </figure>
            ))}
          </div>
          <p role="status">
            {!parsed.success
              ? "请检查参数：输入黑点须小于白点，输出黑点不得大于白点；灰度值为 0–255 整数，Gamma 为 0.1–9.99，最多两位小数。"
              : state.applying
                ? "正在应用，可取消…"
                : state.busy
                  ? "正在计算预览…"
                  : state.error || "预览已更新，确认后可一步撤销。"}
          </p>
        </div>
        <footer>
          <button type="button" onClick={cancel}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={!current || !state.canApply || state.busy}
          >
            应用
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}

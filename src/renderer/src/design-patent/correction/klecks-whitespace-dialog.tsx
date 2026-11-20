import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type WhitespaceOptions,
  WhitespaceOptionsSchema,
} from "../../../../shared/settings/design-whitespace";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksToolCommand } from "./klecks-tool-port";
import type { WhitespaceState } from "./klecks-whitespace-state";

export function KlecksWhitespaceDialog({
  state,
  send,
  frame,
}: {
  state: WhitespaceState;
  send(command: KlecksToolCommand): void;
  frame: KlecksFrameClient;
}) {
  const target = useRef(frame.state.snapshot()?.identity);
  const dialog = useRef<HTMLDialogElement>(null),
    [options, setOptions] = useState(state.options),
    [draft, setDraft] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        ["tolerance", "top", "right", "bottom", "left"].map((k) => [
          k,
          String(state.options[k as keyof WhitespaceOptions]),
        ]),
      ),
    );
  useEffect(() => {
    const node = dialog.current,
      previous = document.activeElement as HTMLElement | null;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus();
      if (target.current)
        void frame.tools.send(target.current, { action: "focus" }).catch(() => {});
    };
  }, [frame]);
  const parsed = WhitespaceOptionsSchema.safeParse({
    ...options,
    ...Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)]),
    ),
  });
  const current = parsed.success && JSON.stringify(parsed.data) === JSON.stringify(state.options);
  const change = (patch: Partial<WhitespaceOptions>, texts = draft) => {
    const next = { ...options, ...patch };
    setOptions(next);
    setDraft(texts);
    const valid = WhitespaceOptionsSchema.safeParse({
      ...next,
      ...Object.fromEntries(
        Object.entries(texts).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)]),
      ),
    });
    if (valid.success) send({ action: "whitespace", operation: "options", options: valid.data });
  };
  const number = (
    key: "tolerance" | "top" | "right" | "bottom" | "left",
    label: string,
    disabled: boolean,
  ) => (
    <label key={key}>
      {label}
      <input
        aria-label={label}
        type="number"
        min={0}
        max={key === "tolerance" ? 50 : 2000}
        step={1}
        disabled={disabled || state.applying}
        value={draft[key]}
        onChange={(e) => {
          const next = { ...draft, [key]: e.currentTarget.value };
          if (key !== "tolerance" && options.linked)
            for (const side of ["top", "right", "bottom", "left"])
              next[side] = e.currentTarget.value;
          change({}, next);
        }}
      />
    </label>
  );
  const cancel = () => send({ action: "whitespace", operation: "cancel" }),
    plan = state.plan;
  return createPortal(
    <dialog
      ref={dialog}
      className="klecks-size-dialog klecks-whitespace-dialog"
      aria-label="白边与留白"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (current && state.canApply && !state.busy)
            send({ action: "whitespace", operation: "apply" });
        }}
      >
        <h2>白边与留白</h2>
        <div className="klecks-whitespace-dialog__body">
          <p>仅处理当前图片的画布边界，不缩放主体；所有图层及选区同步定位，可撤销。</p>
          <fieldset disabled={state.applying}>
            <legend>
              <label className="klecks-size-dialog__check">
                <input
                  type="checkbox"
                  checked={options.trim}
                  onChange={(e) => change({ trim: e.currentTarget.checked })}
                />
                自动裁白边
              </label>
            </legend>
            {number("tolerance", "近白容差", !options.trim)}
            <p>
              0
              仅裁纯白及透明边缘；提高容差会将近白色视为白边。按可见图层合成结果识别，请先核对预览中的浅色细节。
            </p>
          </fieldset>
          <fieldset disabled={state.applying}>
            <legend>
              <label className="klecks-size-dialog__check">
                <input
                  type="checkbox"
                  checked={options.pad}
                  onChange={(e) => change({ pad: e.currentTarget.checked })}
                />
                增加留白
              </label>
            </legend>
            <div className="klecks-whitespace-dialog__margins">
              {number("top", "上边（像素）", !options.pad)}
              {number("right", "右边（像素）", !options.pad)}
              {number("bottom", "下边（像素）", !options.pad)}
              {number("left", "左边（像素）", !options.pad)}
            </div>
            <label className="klecks-size-dialog__check">
              <input
                type="checkbox"
                disabled={!options.pad}
                checked={options.linked}
                onChange={(e) =>
                  change(
                    { linked: e.currentTarget.checked },
                    e.currentTarget.checked
                      ? {
                          ...draft,
                          right: draft.top ?? "",
                          bottom: draft.top ?? "",
                          left: draft.top ?? "",
                        }
                      : draft,
                  )
                }
              />
              四边一致
            </label>
            <label>
              留白颜色
              <select
                aria-label="留白颜色"
                disabled={!options.pad}
                value={options.color}
                onChange={(e) =>
                  change({ color: e.currentTarget.value as "white" | "transparent" })
                }
              >
                <option value="white">白色</option>
                <option value="transparent">透明</option>
              </select>
            </label>
          </fieldset>
          <div className="klecks-whitespace-dialog__previews">
            {[
              ["处理前", state.before],
              ["处理后", current && !state.busy ? state.after : null],
            ].map(([title, url]) => (
              <figure key={title}>
                <figcaption>{title}</figcaption>
                <div>
                  {url ? (
                    <img alt={title!} src={url} />
                  ) : (
                    <span>{state.busy ? "正在计算…" : "暂无有效预览"}</span>
                  )}
                </div>
              </figure>
            ))}
          </div>
          <p role="status">
            {state.applying
              ? "正在处理，可取消…"
              : state.busy
                ? "正在计算预览…"
                : !parsed.success
                  ? "请选择至少一项操作；参数须为范围内的整数。"
                  : state.error ||
                    (plan && current
                      ? `${plan.original.width} × ${plan.original.height} → ${plan.rect.width} × ${plan.rect.height} px；裁去左 ${plan.crop.left}、上 ${plan.crop.top}、右 ${plan.original.width - plan.crop.left - plan.crop.width}、下 ${plan.original.height - plan.crop.top - plan.crop.height} px。`
                      : "等待预览…")}
          </p>
          <p>
            每边留白最多 2000 像素；结果边长最多 10000 像素、总像素最多 4000
            万。白色留白必要时新增边框图层；透明留白会将背景转为普通图层，保留锁定设置。
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

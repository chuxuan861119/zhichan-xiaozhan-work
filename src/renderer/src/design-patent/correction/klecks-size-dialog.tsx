import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KlecksFrameClient } from "./klecks-frame-client";
import type { KlecksEditorState } from "./klecks-state-port";

export function KlecksSizeDialog({
  kind,
  frame,
  state,
  onClose,
}: {
  kind: "image" | "canvas";
  frame: KlecksFrameClient;
  state: KlecksEditorState;
  onClose(): void;
}) {
  const target = useRef(state.identity),
    original = useRef(state.size!),
    dialog = useRef<HTMLDialogElement>(null);
  const [width, setWidth] = useState(String(original.current.width)),
    [height, setHeight] = useState(String(original.current.height)),
    [linked, setLinked] = useState(true),
    [smooth, setSmooth] = useState(true);
  const [anchor, setAnchor] = useState({
      horizontal: "center" as "left" | "center" | "right",
      vertical: "center" as "top" | "center" | "bottom",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current,
      previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
      const identity = target.current;
      if (identity) void frame.tools.send(identity, { action: "focus" }).catch(() => {});
    };
  }, [frame]);
  const update = (field: "width" | "height", text: string) => {
    (field === "width" ? setWidth : setHeight)(text);
    setError(null);
    const number = Number(text);
    if (kind === "image" && linked && text && Number.isFinite(number) && number > 0) {
      if (field === "width")
        setHeight(
          String(
            Math.max(1, Math.round((number * original.current.height) / original.current.width)),
          ),
        );
      else
        setWidth(
          String(
            Math.max(1, Math.round((number * original.current.width) / original.current.height)),
          ),
        );
    }
  };
  const apply = async () => {
    const w = Number(width),
      h = Number(height),
      identity = target.current;
    if (
      !identity ||
      !Number.isSafeInteger(w) ||
      !Number.isSafeInteger(h) ||
      w < 1 ||
      h < 1 ||
      w > 10000 ||
      h > 10000 ||
      w * h > 40000000
    ) {
      setError("宽高须为正整数，边长不超过 10000 像素且总像素不超过 4000 万。");
      return;
    }
    if (JSON.stringify(frame.state.snapshot()?.identity) !== JSON.stringify(identity)) {
      setError("活动图片已改变，请取消后重新打开。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await frame.tools.send(
        identity,
        kind === "image"
          ? {
              action: "resizeImage",
              width: w,
              height: h,
              interpolation: smooth ? "smooth" : "nearest",
              allowDistortion: !linked,
            }
          : { action: "resizeCanvas", width: w, height: h, anchor },
      );
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "尺寸修改未完成，原图与编辑已保留。");
      setBusy(false);
    }
  };
  const title = kind === "image" ? "图像大小" : "画布大小";
  return createPortal(
    <dialog
      ref={dialog}
      className="klecks-size-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void apply();
        }}
      >
        <h2>{title}</h2>
        <p>
          当前：{original.current.width} × {original.current.height} px
        </p>
        <label>
          宽度（像素）
          <input
            autoFocus
            type="number"
            min={1}
            max={10000}
            step={1}
            value={width}
            disabled={busy}
            onChange={(event) => update("width", event.currentTarget.value)}
          />
        </label>
        <label>
          高度（像素）
          <input
            type="number"
            min={1}
            max={10000}
            step={1}
            value={height}
            disabled={busy}
            onChange={(event) => update("height", event.currentTarget.value)}
          />
        </label>
        {kind === "image" ? (
          <>
            <label className="klecks-size-dialog__check">
              <input
                type="checkbox"
                checked={linked}
                disabled={busy}
                onChange={(event) => {
                  setLinked(event.currentTarget.checked);
                  if (event.currentTarget.checked)
                    setHeight(
                      String(
                        Math.max(
                          1,
                          Math.round(
                            (Number(width) * original.current.height) / original.current.width,
                          ),
                        ),
                      ),
                    );
                }}
              />
              约束比例
            </label>
            <label>
              重新采样
              <select
                value={smooth ? "smooth" : "nearest"}
                disabled={busy}
                onChange={(event) => setSmooth(event.currentTarget.value === "smooth")}
              >
                <option value="smooth">平滑插值</option>
                <option value="nearest">邻近（保留硬边）</option>
              </select>
            </label>
            {!linked ? (
              <p className="klecks-size-dialog__warning">
                未约束比例可能改变外观形状，请核对后再应用。
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p>只改变画布边界，不缩放图像像素；画布外像素保留在工程中。</p>
            <fieldset disabled={busy}>
              <legend>定位</legend>
              <div className="klecks-size-dialog__anchors">
                {(["top", "center", "bottom"] as const).flatMap((vertical) =>
                  (["left", "center", "right"] as const).map((horizontal) => (
                    <button
                      key={vertical + horizontal}
                      type="button"
                      aria-label={`${{ top: "上", center: "中", bottom: "下" }[vertical]}${{ left: "左", center: "中", right: "右" }[horizontal]}定位`}
                      aria-pressed={
                        anchor.vertical === vertical && anchor.horizontal === horizontal
                      }
                      onClick={() => setAnchor({ horizontal, vertical })}
                    >
                      {anchor.vertical === vertical && anchor.horizontal === horizontal ? "●" : "·"}
                    </button>
                  )),
                )}
              </div>
            </fieldset>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "正在应用…" : "确定"}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}

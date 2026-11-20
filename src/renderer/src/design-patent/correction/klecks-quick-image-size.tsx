import { Pencil } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KlecksPortIdentity } from "./klecks-command-port";
import type { KlecksFrameClient } from "./klecks-frame-client";
import "./klecks-quick-image-size.css";

type Size = { width: number; height: number };
type Axis = keyof Size;
type Draft = Record<Axis, string> & { base: Size; linked: boolean; last: Axis };

function pixels(text: string): number {
  return /^[0-9]+$/.test(text) ? Number(text) : NaN;
}

function linkSide(draft: Draft): Draft {
  const value = pixels(draft[draft.last]);
  if (!Number.isSafeInteger(value) || value < 1) return draft;
  const opposite = draft.last === "width" ? "height" : "width";
  return {
    ...draft,
    [opposite]: String(
      Math.max(1, Math.round((value * draft.base[opposite]) / draft.base[draft.last])),
    ),
  };
}

export function KlecksQuickImageSize({
  size,
  identity,
  frame,
  disabled,
}: {
  size: Size;
  identity: KlecksPortIdentity;
  frame: KlecksFrameClient;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const widthInput = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  const formId = useId();
  const hintId = useId();
  const open = draft !== null;

  useLayoutEffect(() => {
    if (open) {
      widthInput.current?.focus({ preventScroll: true });
      widthInput.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !submitting.current &&
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      )
        setDraft(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open]);

  const close = () => {
    returnFocus.current = true;
    setDraft(null);
  };
  const width = pixels(draft?.width ?? "");
  const height = pixels(draft?.height ?? "");
  const valid =
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= 10000 &&
    height <= 10000 &&
    width * height <= 40000000;
  const stretches =
    !!draft && !draft.linked && valid && height * draft.base.width !== width * draft.base.height;

  const apply = async () => {
    if (!draft || disabled || submitting.current) return;
    if (!valid) {
      setError("宽高须为正整数；单边最多 10,000 px，总像素最多 4,000 万。");
      return;
    }
    if (
      draft.linked &&
      height !== Math.round((width * draft.base.height) / draft.base.width) &&
      width !== Math.round((height * draft.base.width) / draft.base.height)
    ) {
      setError("此尺寸无法保持原比例，请增大尺寸或关闭等比缩放。");
      return;
    }
    const current = frame.state ? frame.state.snapshot() : { identity, size };
    if (
      current?.identity?.sessionId !== identity.sessionId ||
      current.identity.viewId !== identity.viewId ||
      current.identity.generation !== identity.generation ||
      current.size?.width !== draft.base.width ||
      current.size.height !== draft.base.height
    ) {
      setError("当前图像尺寸已变化，请取消后重新打开。");
      return;
    }
    if (width === draft.base.width && height === draft.base.height) {
      close();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await frame.tools.send(identity, {
        action: "resizeImage",
        width,
        height,
        interpolation: "smooth",
        allowDistortion: !draft.linked,
      });
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "未能调整图像尺寸，请重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="klecks-quick-size" data-klecks-size-edit>
      <span className="klecks-quick-size__value" data-editing={open}>
        {size.width} × {size.height} px
      </span>
      <button
        ref={opener}
        type="button"
        className="klecks-quick-size__edit"
        aria-label="编辑图像尺寸"
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
        title="编辑图像尺寸"
        disabled={disabled || busy}
        onClick={() => {
          if (draft) close();
          else {
            setError(null);
            setDraft({
              base: size,
              width: String(size.width),
              height: String(size.height),
              linked: true,
              last: "width",
            });
          }
        }}
      >
        <Pencil size={13} aria-hidden="true" />
      </button>
      {draft && (
        <form
          id={formId}
          className="klecks-quick-size__form"
          aria-label="调整图像尺寸"
          aria-describedby={error || stretches ? hintId : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              if (!submitting.current) close();
            }
          }}
        >
          <div className="klecks-quick-size__fields">
            {(["width", "height"] as const).map((axis) => (
              <label key={axis}>
                {axis === "width" ? "宽" : "高"}
                <input
                  ref={axis === "width" ? widthInput : undefined}
                  type="text"
                  inputMode="numeric"
                  aria-label={axis === "width" ? "宽度（像素）" : "高度（像素）"}
                  value={draft[axis]}
                  disabled={disabled || busy}
                  onChange={(event) => {
                    const next = { ...draft, [axis]: event.currentTarget.value, last: axis };
                    setError(null);
                    setDraft(next.linked ? linkSide(next) : next);
                  }}
                />
              </label>
            ))}
            <span>px</span>
          </div>
          <label className="klecks-quick-size__link">
            <input
              type="checkbox"
              checked={draft.linked}
              disabled={disabled || busy}
              onChange={(event) => {
                const next = { ...draft, linked: event.currentTarget.checked };
                setError(null);
                setDraft(next.linked ? linkSide(next) : next);
              }}
            />
            等比缩放
          </label>
          <div className="klecks-quick-size__actions">
            <button type="submit" disabled={disabled || busy}>
              {busy ? "应用中…" : "应用"}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              取消
            </button>
          </div>
          {(error || stretches) && (
            <p id={hintId} className="klecks-quick-size__hint" role={error ? "alert" : "status"}>
              {error ?? "将拉伸图像，可能改变产品外形。"}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

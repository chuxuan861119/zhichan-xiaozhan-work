import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type DesignPatent,
  type DesignPatentImageOperation,
  isAssignedDesignView,
} from "../../../../shared/patent/design-patent";
import { CorrectionUnsavedDialog } from "./correction-unsaved-dialog";
import { DesignCorrectionCanvas } from "./design-correction-canvas";
import { clampCropRect } from "./design-correction-geometry";
import { createDesignCorrectionSession, designCorrectionReducer } from "./design-correction-state";
import { DesignCorrectionTools } from "./design-correction-tools";

type Props = {
  design: DesignPatent;
  initialViewId?: string | undefined;
  thumbnailUrls?: Record<string, string>;
  loadPreview(
    viewId: string,
    assetId: string,
    operations: readonly DesignPatentImageOperation[],
  ): Promise<Uint8Array | null>;
  onApply(
    viewId: string,
    committed: readonly DesignPatentImageOperation[],
    draft: readonly DesignPatentImageOperation[],
  ): boolean;
  onDirtyChange?(dirty: boolean): void;
};

export type DesignImageCorrectionStepHandle = { apply(): boolean; discard(): void };

export const DesignImageCorrectionStep = forwardRef<DesignImageCorrectionStepHandle, Props>(
  function DesignImageCorrectionStep(
    { design, initialViewId, thumbnailUrls = {}, loadPreview, onApply, onDirtyChange },
    ref,
  ) {
    const views = design.views.filter(isAssignedDesignView);
    const initial = views.find((view) => view.viewId === initialViewId) ?? views[0];
    const [session, dispatch] = useReducer(designCorrectionReducer, initial, (view) =>
      createDesignCorrectionSession(view?.viewId ?? "", view?.operations ?? []),
    );
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
    const [showOriginal, setShowOriginal] = useState(false);
    const [comparisonMode, setComparisonMode] = useState<"side-by-side" | "slider">("side-by-side");
    const [comparisonRatio, setComparisonRatio] = useState(50);
    const [crop, setCrop] = useState({ left: 0, top: 0, width: 1200, height: 1200 });
    const [canvas, setCanvas] = useState({ width: 1600, height: 1600 });
    const [imageSize, setImageSize] = useState({ width: 1200, height: 1200 });
    const [pendingViewId, setPendingViewId] = useState<string | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const requestId = useRef(0);
    const previewUrlRef = useRef<string | null>(null);
    const originalPreviewUrlRef = useRef<string | null>(null);
    const view = views.find((item) => item.viewId === session.viewId) ?? null;
    const dirty = JSON.stringify(session.committed) !== JSON.stringify(session.draft);

    useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
    const apply = useCallback(() => {
      if (!dirty) return true;
      if (!view) return false;
      if (!onApply(view.viewId, session.committed, session.draft)) return false;
      dispatch({ type: "apply" });
      return true;
    }, [dirty, view, onApply, session.committed, session.draft]);
    useImperativeHandle(
      ref,
      () => ({
        apply,
        discard: () => dispatch({ type: "cancel" }),
      }),
      [apply],
    );

    useEffect(() => {
      if (!view) {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
        setPreviewUrl(null);
        return;
      }
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      setPreviewUrl(null);
      const id = ++requestId.current;
      dispatch({ type: "render-start", requestId: id });
      void loadPreview(view.viewId, view.assetId, session.draft).then(
        (bytes) => {
          if (id !== requestId.current) return;
          if (!bytes) {
            setPreviewUrl(null);
            dispatch({ type: "render-error", requestId: id });
            return;
          }
          const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
          if (id !== requestId.current) {
            URL.revokeObjectURL(url);
            return;
          }
          previewUrlRef.current = url;
          setPreviewUrl(url);
          dispatch({ type: "render-ready", requestId: id });
        },
        () => {
          if (id === requestId.current) dispatch({ type: "render-error", requestId: id });
        },
      );
      return () => {
        requestId.current++;
      };
    }, [loadPreview, session.draft, view]);
    useEffect(
      () => () => {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      },
      [],
    );
    useEffect(
      () => () => {
        if (originalPreviewUrlRef.current) URL.revokeObjectURL(originalPreviewUrlRef.current);
      },
      [],
    );

    useEffect(() => {
      if (!showOriginal || !view) return;
      let cancelled = false;
      if (originalPreviewUrlRef.current) URL.revokeObjectURL(originalPreviewUrlRef.current);
      originalPreviewUrlRef.current = null;
      setOriginalPreviewUrl(null);
      void loadPreview(view.viewId, view.assetId, []).then((bytes) => {
        if (cancelled || !bytes) return;
        const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        originalPreviewUrlRef.current = url;
        setOriginalPreviewUrl(url);
      });
      return () => {
        cancelled = true;
      };
    }, [loadPreview, showOriginal, view]);

    if (!view)
      return (
        <section aria-labelledby="correction-heading">
          <h2 id="correction-heading" tabIndex={-1}>
            小栈修图
          </h2>
          <p>
            {views.length
              ? "当前图片已不存在，请重新选择图片。"
              : "暂无已分配图片，请先在图片整理中设置视图。"}
          </p>
          <button type="button" disabled>
            应用修改
          </button>
        </section>
      );
    const reload = () => dispatch({ type: "replace-draft", operations: [...session.draft] });
    const append = (operation: DesignPatentImageOperation) =>
      dispatch({ type: "replace-draft", operations: [...session.draft, operation] });
    const updateCrop = (field: keyof typeof crop, value: string) =>
      setCrop((current) => ({
        ...current,
        [field]: Math.max(
          field === "left" || field === "top" ? 0 : 1,
          Number.parseInt(value, 10) || 0,
        ),
      }));
    const updateCanvas = (field: keyof typeof canvas, value: string) =>
      setCanvas((current) => ({
        ...current,
        [field]: Math.max(1, Number.parseInt(value, 10) || 0),
      }));
    return (
      <section className="design-correction-step" aria-labelledby="correction-heading">
        <header className="design-correction-step__header">
          <div>
            <h2 id="correction-heading" tabIndex={-1}>
              小栈修图
            </h2>
            <p>逐张检查方向、边界和输出尺寸，修改只在点击“应用修改”后保存。</p>
          </div>
          <span className={dirty ? "is-dirty" : ""}>
            {dirty ? "有未保存修改" : "当前图片已保存"}
          </span>
        </header>
        <aside className="design-correction-step__navigator" aria-label="校正图片列表">
          <h3>图片</h3>
          <div>
            {views.map((item) => (
              <button
                key={item.viewId}
                type="button"
                aria-label={`${item.label}${item.viewId === view.viewId ? "（当前）" : ""}`}
                aria-pressed={item.viewId === view.viewId}
                onClick={() =>
                  dirty && item.viewId !== view.viewId
                    ? setPendingViewId(item.viewId)
                    : dispatch({
                        type: "switch-view",
                        viewId: item.viewId,
                        operations: item.operations,
                      })
                }
              >
                {thumbnailUrls[item.viewId] ? (
                  <img src={thumbnailUrls[item.viewId]} alt={`${item.label}缩略图`} />
                ) : (
                  <span className="design-correction-step__thumb-empty">无预览</span>
                )}
                <span>{item.label}</span>
                {item.viewId === view.viewId ? <small>当前</small> : null}
              </button>
            ))}
          </div>
        </aside>
        <section className="design-correction-step__preview" aria-label="图片预览">
          <header>
            <div>
              <h3>{view.label}</h3>
              <p>
                {imageSize.width} × {imageSize.height} 像素
              </p>
            </div>
            <div className="design-correction-step__preview-actions">
              <button type="button" onClick={reload}>
                重新加载
              </button>
              <button type="button" onClick={() => setShowOriginal((current) => !current)}>
                {showOriginal ? "返回处理图" : "查看原图"}
              </button>
              {showOriginal ? (
                <button
                  type="button"
                  onClick={() =>
                    setComparisonMode((current) =>
                      current === "side-by-side" ? "slider" : "side-by-side",
                    )
                  }
                >
                  {comparisonMode === "side-by-side" ? "滑杆比较" : "并排比较"}
                </button>
              ) : null}
            </div>
          </header>
          {session.render.status === "error" ? (
            <p className="design-correction-step__preview-error">
              没有可用预览，请重新加载或检查图片。
            </p>
          ) : (
            <DesignCorrectionCanvas
              imageUrl={previewUrl}
              imageAlt={`${view.label}预览`}
              imageSize={imageSize}
              crop={crop}
              onCropChange={setCrop}
              onImageSizeChange={(nextSize) => {
                setImageSize(nextSize);
                setCrop((current) => clampCropRect(current, nextSize));
              }}
            />
          )}
          {showOriginal ? (
            <figure>
              <figcaption>
                {comparisonMode === "side-by-side"
                  ? "原图与处理图并排比较（只读）"
                  : "拖动滑杆查看处理前后差异（只读）"}
              </figcaption>
              {comparisonMode === "side-by-side" ? (
                <div className="design-correction-step__compare">
                  {previewUrl ? <img src={previewUrl} alt={`${view.label}处理图对比`} /> : null}
                  {originalPreviewUrl ? (
                    <img src={originalPreviewUrl} alt={`${view.label}原图`} />
                  ) : (
                    <p>正在加载原图</p>
                  )}
                </div>
              ) : (
                <div className="design-correction-step__slider-compare">
                  {originalPreviewUrl ? (
                    <img src={originalPreviewUrl} alt={`${view.label}原图`} />
                  ) : (
                    <p>正在加载原图</p>
                  )}
                  {previewUrl ? (
                    <div style={{ clipPath: `inset(0 ${100 - comparisonRatio}% 0 0)` }}>
                      <img src={previewUrl} alt={`${view.label}处理图对比`} />
                    </div>
                  ) : null}
                  <input
                    aria-label="处理图揭示比例"
                    type="range"
                    min="0"
                    max="100"
                    value={comparisonRatio}
                    onChange={(event) => setComparisonRatio(Number(event.target.value))}
                  />
                </div>
              )}
            </figure>
          ) : null}
        </section>
        <DesignCorrectionTools>
          <div className="design-correction-step__tools-heading">
            <h3>校正工具</h3>
            <p>先完成常用操作，需要精确数值时再展开高级参数。</p>
          </div>
          <section className="design-correction-step__control-group" aria-label="旋转">
            <strong>旋转方向</strong>
            <div>
              <button type="button" onClick={() => append({ kind: "rotate", degrees: -90 })}>
                向左旋转 90°
              </button>
              <button type="button" onClick={() => append({ kind: "rotate", degrees: 90 })}>
                向右旋转 90°
              </button>
            </div>
          </section>
          <section className="design-correction-step__control-group" aria-label="裁剪">
            <strong>裁剪图片</strong>
            <p>拖动预览中的绿色边框，保留需要的产品区域。</p>
            <button type="button" onClick={() => append({ kind: "trim", ...crop })}>
              应用当前裁剪框
            </button>
          </section>
          <section className="design-correction-step__control-group" aria-label="统一尺寸">
            <strong>统一输出尺寸</strong>
            <p>
              保持图片比例并居中放入 {canvas.width} × {canvas.height} 像素画布。
            </p>
            <button
              type="button"
              onClick={() => append({ kind: "canvas", ...canvas, fit: "contain" })}
            >
              统一到此尺寸
            </button>
          </section>
          <button
            className="design-correction-step__advanced-toggle"
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            高级参数
          </button>
          {advancedOpen ? (
            <div className="design-correction-step__advanced">
              <fieldset className="design-correction-step__control-group">
                <legend>精确裁剪范围（像素）</legend>
                {(["left", "top", "width", "height"] as const).map((field) => (
                  <label key={field}>
                    {{ left: "左边距", top: "上边距", width: "宽度", height: "高度" }[field]}
                    <input
                      aria-label={`裁剪 ${field}`}
                      type="number"
                      min={field === "left" || field === "top" ? 0 : 1}
                      value={crop[field]}
                      onChange={(event) => updateCrop(field, event.target.value)}
                    />
                  </label>
                ))}
              </fieldset>
              <fieldset className="design-correction-step__control-group">
                <legend>输出画布（像素）</legend>
                {(["width", "height"] as const).map((field) => (
                  <label key={field}>
                    {field === "width" ? "宽度" : "高度"}
                    <input
                      aria-label={`画布 ${field}`}
                      type="number"
                      min="1"
                      value={canvas[field]}
                      onChange={(event) => updateCanvas(field, event.target.value)}
                    />
                  </label>
                ))}
              </fieldset>
            </div>
          ) : null}
        </DesignCorrectionTools>
        <section className="design-correction-step__actionbar" aria-label="校正操作栏">
          <div className="design-correction-step__history">
            <strong>{dirty ? "有未应用的修改" : "修改已应用"}</strong>
            {session.draft.some(
              (operation) =>
                operation.kind === "affine" ||
                (operation.kind === "canvas" && operation.fit === "fill"),
            ) ? (
              <p>历史透视/填充操作仅保留回放；请使用裁剪、直角旋转或等比例画布继续校正。</p>
            ) : null}
            <ol aria-label="当前校正步骤">
              {session.draft.map((operation, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable, display-only operation positions have no IDs.
                <li key={`${operation.kind}-${index}`}>
                  {operation.kind === "affine"
                    ? "历史透视校正（只读）"
                    : operation.kind === "canvas" && operation.fit === "fill"
                      ? "历史填充画布（只读）"
                      : operation.kind === "rotate"
                        ? `旋转 ${operation.degrees}°`
                        : operation.kind === "trim"
                          ? "裁剪"
                          : "等比例画布"}
                </li>
              ))}
            </ol>
          </div>
          <div className="design-correction-step__action-buttons">
            <button type="button" onClick={() => dispatch({ type: "undo" })}>
              撤销
            </button>
            <button type="button" onClick={() => dispatch({ type: "redo" })}>
              重做
            </button>
            <button type="button" onClick={() => dispatch({ type: "reset" })}>
              重置
            </button>
            <button type="button" onClick={() => dispatch({ type: "cancel" })}>
              放弃修改
            </button>
            <button className="primary-button" type="button" disabled={!dirty} onClick={apply}>
              应用修改
            </button>
          </div>
        </section>
        {pendingViewId ? (
          <CorrectionUnsavedDialog
            onStay={() => setPendingViewId(null)}
            onDiscard={() => {
              dispatch({ type: "cancel" });
              const next = views.find((item) => item.viewId === pendingViewId);
              if (next)
                dispatch({ type: "switch-view", viewId: next.viewId, operations: next.operations });
              setPendingViewId(null);
            }}
            onApply={() => {
              if (apply()) {
                const next = views.find((item) => item.viewId === pendingViewId);
                if (next)
                  dispatch({
                    type: "switch-view",
                    viewId: next.viewId,
                    operations: next.operations,
                  });
                setPendingViewId(null);
              }
            }}
          />
        ) : null}
      </section>
    );
  },
);

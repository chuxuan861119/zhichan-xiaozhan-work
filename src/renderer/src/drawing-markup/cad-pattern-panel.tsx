import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { DrawingPoint } from "../../../shared/drawing-markup/model";
import { useMotionPresenceClosing } from "../app/motion-presence";
import { CadNumberInput } from "./cad-number-input";
import { readHatchPreferences } from "./cad-hatch-preferences";
import {
  compilePatternCommand,
  type PatternTool,
  type PatternValues,
} from "./cad-pattern-command";
import type { CadScene } from "./cadcraft-client";

export type CadPatternHandle = { apply(): boolean; hover(point: DrawingPoint | null): void };
type Props = {
  ref?: Ref<CadPatternHandle>;
  mode: PatternTool;
  handles: string[];
  scene: CadScene;
  point: DrawingPoint | null;
  path?: string | undefined;
  points?: DrawingPoint[];
  removePoint?: (index: number) => void;
  picking: boolean;
  disabled: boolean;
  protectedHandles: string[];
  query: (command: string, params: object) => Promise<unknown>;
  preview: (scene: CadScene | null) => void;
  apply: (command: string, params: object) => Promise<unknown>;
  pick: (objects: boolean) => void;
  cancel: () => void;
  hint: (message: string) => void;
};
export function CadPatternPanel(props: Props) {
  const id = useId();
  const closing = useMotionPresenceClosing();
  const [values, setValues] = useState<PatternValues>(readHatchPreferences);
  const [loaded, setLoaded] = useState("");
  const [error, setError] = useState("");
  const [previewKey, setPreviewKey] = useState("");
  const [patterns, setPatterns] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [swatches, setSwatches] = useState<{ name: string; solid: boolean; path: string }[]>([]);
  const [swatchError, setSwatchError] = useState("");
  const requestedApply = useRef("");
  const applying = useRef(false);
  const previewQueue = useRef(Promise.resolve());
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const hoverCurrent = useRef<DrawingPoint | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverSession = useRef(0);
  const hoverBusy = useRef(false);
  const hoverJob = useRef<{
    key: string;
    context: string;
    scene: CadScene;
    session: number;
  } | null>(null);
  const confirmedPreview = useRef<CadScene | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (props.mode !== "hatch" || closing) return;
    let cancelled = false;
    void latest.current
      .query("hatch.patterns", {})
      .then((result) => {
        if (cancelled) return;
        const catalog = result as { standard: string[]; user: { name: string }[] };
        setPatterns([...new Set([...catalog.standard, ...catalog.user.map((p) => p.name)])]);
        setCatalogError("");
      })
      .catch(() => {
        if (!cancelled) setCatalogError("填充图案列表未能加载，请重新打开剖面填充。");
      });
    return () => {
      cancelled = true;
    };
  }, [props.mode, closing]);
  useEffect(() => {
    if (props.mode !== "hatch" || closing) return;
    let cancelled = false;
    void latest.current
      .query("bridge.hatch_swatches", {})
      .then((result) => {
        if (!Array.isArray(result)) throw new Error("图案预览数据无效");
        if (!cancelled)
          setSwatches(
            result.map((s: { name: string; solid: boolean; lines: number[][][] }) => ({
              name: s.name,
              solid: s.solid,
              path: s.lines
                .map((line) =>
                  line.map((p, i) => `${i ? "L" : "M"}${p[0]},${64 - p[1]!}`).join(" "),
                )
                .join(" "),
            })),
          );
      })
      .catch(() => {
        if (!cancelled) setSwatchError("图案小样未能加载，可点击中文名称通过画布预览选择。");
      });
    return () => {
      cancelled = true;
    };
  }, [props.mode, closing]);
  const patternCards = [
    ...new Set([...patterns, ...swatches.map((s) => s.name), values.pattern]),
  ].map((name, index) => ({
    name,
    label: PATTERN_LABELS[name] ?? `自定义图案${index + 1}`,
    sample: swatches.find((s) => s.name === name),
  }));
  const selected = props.scene.entities.filter((e) => props.handles.includes(e.handle));
  const editHatch =
    props.mode === "hatch" &&
    selected.length > 0 &&
    selected.every((e) => e.type.toLowerCase() === "hatch");
  const selectionKey = props.handles.join(",");
  // Pointer samples may supersede each other without invalidating a completed
  // preview. Parameter, selection and lifecycle changes still invalidate it.
  const hoverContext = useRef("");
  hoverContext.current = JSON.stringify([
    values,
    selectionKey,
    props.points,
    props.point,
    props.mode,
    props.picking,
    props.disabled,
    closing,
  ]);
  useEffect(() => {
    if (!editHatch || props.picking || closing) return;
    let cancelled = false;
    setLoaded("");
    void latest.current
      .query("properties", { handles: latest.current.handles })
      .then((result) => {
        if (cancelled) return;
        const objects = (
          result as {
            objects: {
              geometry: {
                pattern: string;
                scale: number;
                angle: number;
                style?: number;
              };
            }[];
          }
        ).objects;
        if (objects.length !== 1) throw new Error("请一次选择一个剖面填充进行修改。");
        const h = objects[0]?.geometry;
        if (!h || !h.pattern || !Number.isFinite(h.scale) || !Number.isFinite(h.angle))
          throw new Error("无法读取此填充的参数，请重新选择。");
        setValues((v) => ({
          ...v,
          pattern: h.pattern,
          scale: String(h.scale),
          hatchAngle: String((h.angle * 180) / Math.PI),
          islandStyle: h.style === 1 ? "outer" : h.style === 2 ? "ignore" : "normal",
        }));
        setLoaded(selectionKey);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          latest.current.hint(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editHatch, selectionKey, props.picking, closing]);
  let compiled: ReturnType<typeof compilePatternCommand> | undefined;
  let validation = "";
  try {
    if (closing) throw new Error("");
    if (props.picking) throw new Error("点击或框选对象，Enter 确认选择，Shift 移除。");
    if (props.handles.some((h) => props.protectedHandles.includes(h)))
      throw new Error("请只选择普通 CAD 图形；专利标号和局部放大图不参与此操作。");
    if (selected.some((e) => e.locked)) throw new Error("选中对象位于锁定图层，请先解锁。");
    if (
      props.mode === "hatch" &&
      selected.some((e) => e.type.toLowerCase() === "hatch") &&
      !editHatch
    )
      throw new Error("请分别选择填充或边界，不要混合选择。");
    if (editHatch && loaded !== selectionKey) throw new Error("正在读取填充参数…");
    const points = props.points ?? (props.point ? [props.point] : []);
    compiled = compilePatternCommand(
      props.mode,
      values,
      props.mode === "hatch" && !editHatch ? [] : props.handles,
      props.mode === "hatch" ? points : props.point,
      editHatch,
      props.path,
    );
  } catch (e) {
    validation = (e as Error).message;
  }
  const key = compiled ? JSON.stringify(compiled) : "";
  const pickProblem = useRef<{ key: string; message: string } | null>(null);
  const submit = useCallback((command: NonNullable<ReturnType<typeof compilePatternCommand>>) => {
    if (applying.current) return;
    applying.current = true;
    requestedApply.current = "";
    void latest.current.apply(command.command, command.params).finally(() => {
      applying.current = false;
    });
  }, []);
  function apply(): boolean {
    if (props.disabled || closing || props.picking || error || !compiled) return false;
    if (key !== previewKey) {
      requestedApply.current = key;
      props.hint("正在确认填充或阵列预览；Esc 可取消。");
      return true;
    }
    submit(compiled);
    return true;
  }
  useImperativeHandle(props.ref, () => ({
    apply,
    hover(point) {
      if (props.mode !== "hatch" || editHatch || props.picking || props.disabled || closing)
        point = null;
      hoverCurrent.current = point;
      if (!point) {
        hoverSession.current++;
        hoverJob.current = null;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
        setHoverPoint(null);
        latest.current.preview(confirmedPreview.current);
      } else if (!hoverTimer.current) {
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          setHoverPoint(hoverCurrent.current);
        }, 16);
      }
    },
  }));
  // Hover is transient. It cannot pick regions, enable Apply, save, or enter history.
  const hoverKey =
    hoverPoint &&
    !props.points?.some((p) => p.x === hoverPoint.x && p.y === hoverPoint.y) &&
    props.mode === "hatch" &&
    !editHatch &&
    !props.picking &&
    !props.disabled &&
    !closing &&
    (!key || key === previewKey)
      ? (() => {
          try {
            return JSON.stringify(
              compilePatternCommand("hatch", values, [], [...(props.points ?? []), hoverPoint]),
            );
          } catch {
            return "";
          }
        })()
      : "";
  useEffect(() => {
    if (!hoverKey) return;
    hoverJob.current = {
      key: hoverKey,
      context: hoverContext.current,
      scene: props.scene,
      session: hoverSession.current,
    };
    if (hoverBusy.current) return;
    const run = async () => {
      hoverBusy.current = true;
      try {
        while (hoverJob.current) {
          const job = hoverJob.current;
          hoverJob.current = null;
          const valid = () =>
            hoverCurrent.current !== null &&
            job.session === hoverSession.current &&
            job.context === hoverContext.current &&
            job.scene === latest.current.scene;
          if (!valid()) continue;
          const resultPromise = previewQueue.current.then(() =>
            valid()
              ? latest.current.query("bridge.preview_modify", JSON.parse(job.key))
              : undefined,
          );
          // Serialize with confirmed previews without building a queue of pointer samples.
          previewQueue.current = resultPromise.then(
            () => {},
            () => {},
          );
          let result: unknown;
          try {
            result = await resultPromise;
          } catch {
            if (valid()) latest.current.preview(confirmedPreview.current);
            continue;
          }
          if (!valid() || !result) continue;
          const scene = result as CadScene;
          latest.current.preview(scene);
          latest.current.hint(
            pickProblem.current?.message ??
              (scene.gapPoints?.length
                ? scene.rejectedPointIndices?.includes((latest.current.points ?? []).length)
                  ? "红圈处可能存在缺口；可调整缺口容差后预览。"
                  : "已按缺口容差预览，原线条保持不变；点击选定区域。"
                : "点击选定填充区域；右键 / Enter 完成，Esc 取消。"),
          );
        }
      } finally {
        hoverBusy.current = false;
      }
    };
    void run();
  }, [hoverKey, props.scene]);
  // Delay only expensive geometry work. Old responses can never enable confirmation.
  useEffect(() => {
    let cancelled = false;
    if (pickProblem.current?.key !== key) pickProblem.current = null;
    if (requestedApply.current !== key) requestedApply.current = "";
    setPreviewKey("");
    setError("");
    if (!key || props.disabled || closing) {
      confirmedPreview.current = null;
      if (!hoverCurrent.current) latest.current.preview(null);
      if (pickProblem.current) latest.current.hint(pickProblem.current.message);
      else if (validation) latest.current.hint(validation);
      return;
    }
    latest.current.hint(pickProblem.current?.message ?? "正在生成预览…");
    const timer = setTimeout(() => {
      previewQueue.current = previewQueue.current
        .then(() =>
          cancelled ? undefined : latest.current.query("bridge.preview_modify", JSON.parse(key)),
        )
        .then((result) => {
          if (cancelled) return;
          const checked = result as CadScene;
          if (Array.isArray(checked.acceptedPointIndices) && latest.current.removePoint) {
            const accepted = new Set(checked.acceptedPointIndices);
            const points = latest.current.points ?? [];
            if (accepted.size < points.length) {
              requestedApply.current = "";
              const normalized = JSON.parse(key);
              const field = normalized.params.boundaryPoints ? "boundaryPoints" : "points";
              normalized.params[field] = normalized.params[field].filter((_: unknown, i: number) =>
                accepted.has(i),
              );
              if (field === "points" && accepted.size <= 1) delete normalized.params.separate;
              const message = checked.rejectedPointIndices?.length
                ? "未能填充所选位置：未找到封闭边界（轮廓未闭合或点击在区域外）。该位置未加入，其他有效区域保留。"
                : "该区域已选择，不会重复添加。";
              pickProblem.current = {
                key: accepted.size ? JSON.stringify(normalized) : "",
                message,
              };
              for (let i = points.length - 1; i >= 0; i--)
                if (!accepted.has(i)) latest.current.removePoint(i);
              latest.current.preview(accepted.size ? checked : null);
              latest.current.hint(message);
              return;
            }
          }
          confirmedPreview.current = result as CadScene;
          // A click owns its confirmed preview, even while the pointer stays at
          // that point. Do not wait for another move/leave to reveal the result.
          latest.current.preview(result as CadScene);
          setPreviewKey(key);
          latest.current.hint(
            pickProblem.current?.message ?? "预览已更新；右键 / Enter 或点击“应用”完成，Esc 取消。",
          );
          if (requestedApply.current === key) submit(JSON.parse(key));
        })
        .catch((e) => {
          if (cancelled) return;
          requestedApply.current = "";
          const message = `无法生成预览：${e instanceof Error ? e.message : String(e)}。请检查选择、边界或参数。`;
          setError(message);
          latest.current.hint(message);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      requestedApply.current = "";
    };
  }, [key, validation, props.disabled, closing, submit]);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverCurrent.current = null;
      hoverJob.current = null;
      hoverSession.current++;
      latest.current.preview(null);
    },
    [],
  );
  const field = (name: keyof PatternValues, label: string, min?: number, max?: number) => (
    <label className="cad-tool-parameter" htmlFor={`${id}-${name}`}>
      {label}
      <CadNumberInput
        id={`${id}-${name}`}
        decimals={
          name === "rows" || name === "cols" || name === "count" || name === "gapTolerance"
            ? null
            : 1
        }
        aria-label={label}
        scientificWhenTiny={name !== "hatchAngle" && name !== "axisAngle" && name !== "angle"}
        placeholder={name === "gapTolerance" ? "自动" : undefined}
        value={String(values[name])}
        min={min}
        max={max}
        step={name === "rows" || name === "cols" || name === "count" ? 1 : "any"}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
      />
    </label>
  );
  return (
    <fieldset className="cad-pattern-panel" disabled={props.disabled} aria-label="阵列与填充参数">
      <legend>
        {props.mode === "arrayrect"
          ? "线性阵列"
          : props.mode === "arraypath"
            ? "路径阵列"
            : props.mode === "arraypolar"
              ? "圆周阵列"
              : editHatch
                ? "修改剖面填充"
                : "剖面填充"}
      </legend>
      <div className="cad-pattern-fields">
        {props.mode === "arrayrect" && (
          <>
            {field("rows", "行数", 1, 1000)}
            {field("cols", "列数", 1, 1000)}
            {field("rowSpacing", "行间距")}
            {field("colSpacing", "列间距")}
            {field("axisAngle", "方向角（°）")}
          </>
        )}
        {props.mode === "arraypath" && (
          <>
            {field("count", "项目数（含源对象）", 2, 1000)}
            <label className="cad-snap-toggle">
              <input
                type="checkbox"
                checked={values.rotate}
                onChange={(e) => setValues((v) => ({ ...v, rotate: e.target.checked }))}
              />
              沿路径旋转
            </label>
            <button type="button" onClick={() => props.pick(false)}>
              {props.path ? "重新选择路径" : "选择路径"}
            </button>
            <small>
              {props.path
                ? "已选择路径，可在画布上改选。"
                : "先选择要复制的对象，再点选一条直线或曲线作为路径。"}
            </small>
          </>
        )}
        {props.mode === "arraypolar" && (
          <>
            {field("count", "项目数（含源对象）", 2, 1000)}
            {field("angle", "分布角度（°）", -360, 360)}
            <label className="cad-snap-toggle">
              <input
                type="checkbox"
                checked={values.rotate}
                onChange={(e) => setValues((v) => ({ ...v, rotate: e.target.checked }))}
              />
              随阵列旋转
            </label>
            <button type="button" onClick={() => props.pick(false)}>
              {props.point ? "重新指定圆心" : "指定圆心"}
            </button>
          </>
        )}
        {props.mode === "hatch" && (
          <>
            {catalogError && <span role="alert">{catalogError}</span>}
            {values.pattern !== "SOLID" && (
              <>
                {field("scale", "填充比例", 0)}
                {field("hatchAngle", "填充角度（°）")}
              </>
            )}
            {!editHatch && field("gapTolerance", "缺口容差", 0, 5000)}
            {!editHatch && <small>留空自动忽略微小缺口，0 表示严格闭合；不修改原线条。</small>}
            <label className="cad-tool-parameter">
              填充策略
              <select
                aria-label="填充策略"
                value={values.islandStyle}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    islandStyle: e.target.value as PatternValues["islandStyle"],
                  }))
                }
              >
                <option value="normal">交替填充</option>
                <option value="outer">仅外部</option>
                <option value="ignore">忽略内部</option>
              </select>
            </label>
            {patternCards.length > 0 && (
              <fieldset className="cad-hatch-swatches" aria-label="填充图案">
                <legend>填充图案</legend>
                {patternCards.map(({ name, label, sample }) => (
                  <button
                    key={name}
                    type="button"
                    title={label}
                    aria-label={`选择图案 ${label}`}
                    data-pattern={name}
                    aria-pressed={values.pattern === name}
                    onClick={() => setValues((v) => ({ ...v, pattern: name }))}
                  >
                    <svg
                      viewBox="8 8 48 48"
                      preserveAspectRatio="xMidYMid slice"
                      aria-hidden="true"
                      overflow="hidden"
                    >
                      {!sample ? (
                        <text x="32" y="32" textAnchor="middle" fontSize="4" fill="currentColor">
                          暂无小样
                        </text>
                      ) : sample.solid ? (
                        <rect width="64" height="64" fill="currentColor" />
                      ) : (
                        <path
                          d={sample.path}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="0.75"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </svg>
                    <span>{label}</span>
                  </button>
                ))}
              </fieldset>
            )}
            {swatchError && <span role="status">{swatchError}</span>}
            {(props.points?.length ?? 0) > 0 && (
              <fieldset className="cad-hatch-regions" aria-label="已拾取区域">
                {props.points?.map((point, index) => (
                  <button
                    key={`${point.x}:${point.y}`}
                    type="button"
                    onClick={() => props.removePoint?.(index)}
                    aria-label={`移除区域 ${index + 1}`}
                  >
                    区域 {index + 1} ×
                  </button>
                ))}
              </fieldset>
            )}
          </>
        )}
      </div>
      {props.mode !== "hatch" && (
        <div className="cad-pattern-actions">
          <button type="button" onClick={() => props.pick(true)}>
            选择对象
          </button>
          {props.picking && <span>按 Enter 确认选择</span>}
        </div>
      )}
      <div className="cad-pattern-actions">
        <button type="button" onClick={props.cancel}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!key || key !== previewKey || !!error || props.picking}
          onClick={apply}
        >
          应用
        </button>
      </div>
    </fieldset>
  );
}

const PATTERN_LABELS: Record<string, string> = {
  SOLID: "实心",
  ANSI31: "单线",
  ANSI32: "双斜线",
  ANSI33: "长短线",
  ANSI34: "斜线组",
  ANSI35: "间隔线",
  ANSI36: "双虚线",
  ANSI37: "交叉线",
  ANSI38: "双交线",
  LINE: "平行线",
  NET: "方网格",
  NET3: "三角网",
  DOTS: "点状",
  DASH: "虚线",
  BRICK: "砖块",
  SQUARE: "方格",
  CROSS: "十字",
  EARTH: "土纹",
  GRASS: "草纹",
  HONEY: "蜂窝",
  ZIGZAG: "折线",
  "AR-CONC": "混凝土",
  "AR-SAND": "砂石",
};

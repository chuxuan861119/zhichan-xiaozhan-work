import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { UI_MOTION_DURATION_MS, UI_MOTION_EASING } from "../app/ui-motion";
import { DesignStepMotion } from "./design-step-motion";
import {
  DESIGN_WORKFLOW_STEPS,
  type DesignWorkflowStatus,
  type DesignWorkflowStatuses,
  type DesignWorkflowStep,
  type DesignWorkflowTarget,
} from "./design-workflow";
import "./design-patent-workbench.css";

export type { DesignWorkflowTarget } from "./design-workflow";

type Props = {
  statuses: DesignWorkflowStatuses;
  bodies: Record<DesignWorkflowStep, ReactNode>;
  target: DesignWorkflowTarget | null;
  activeStep?: DesignWorkflowStep;
  onStepChange?(step: DesignWorkflowStep): void;
  onBeforeStepChange?(nextStep: DesignWorkflowStep): boolean;
  retainCorrection?: boolean;
};

export const DesignCorrectionNavigation = createContext<ReactNode>(null);

const STEP_META: Record<DesignWorkflowStep, { label: string; description: string }> = {
  images: { label: "图片整理", description: "导入并确认各视图" },
  correction: { label: "小栈修图", description: "裁切、旋转与尺寸核对" },
  brief: { label: "简要说明", description: "填写外观设计说明" },
  review: { label: "导出", description: "导出申请文件" },
};
const STATUS_LABELS: Record<DesignWorkflowStatus, string> = {
  "not-started": "未开始",
  "in-progress": "进行中",
  "needs-attention": "需处理",
  complete: "已完成",
};

export function DesignWorkspaceShell({
  statuses,
  bodies,
  target,
  activeStep: controlledActiveStep,
  onStepChange,
  onBeforeStepChange,
  retainCorrection = false,
}: Props) {
  const [uncontrolledActiveStep, setUncontrolledActiveStep] =
    useState<DesignWorkflowStep>("images");
  const activeStep = controlledActiveStep ?? uncontrolledActiveStep;
  const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [retainedSteps, setRetainedSteps] = useState<DesignWorkflowStep[]>([activeStep]);
  useLayoutEffect(() => {
    if (reducedMotion) {
      setRetainedSteps([activeStep]);
      return;
    }
    setRetainedSteps((previous) => [...new Set([...previous, activeStep])]);
    const timer = window.setTimeout(() => setRetainedSteps([activeStep]), UI_MOTION_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [activeStep, reducedMotion]);
  const changeStep = (step: DesignWorkflowStep) => {
    if (step !== activeStep && onBeforeStepChange?.(step) === false) return;
    if (controlledActiveStep === undefined) setUncontrolledActiveStep(step);
    onStepChange?.(step);
  };
  const focusStep = (step: DesignWorkflowStep) => {
    changeStep(step);
    queueMicrotask(() => document.getElementById(`${tabIdPrefix}-${step}-tab`)?.focus());
  };
  const tabIdPrefix = useId();
  const targetSignature = target ? `${target.step}:${target.headingId}` : null;
  const compact = retainCorrection && activeStep === "correction";
  const workspaceRoot = useRef<HTMLElement>(null);
  const correctionNavigation = retainCorrection ? (
    <select
      className="klecks-panels__workflow"
      aria-label="外观设计步骤"
      title="外观设计工作台"
      value={activeStep}
      onChange={(event) => {
        const step = DESIGN_WORKFLOW_STEPS.find((item) => item === event.currentTarget.value);
        if (step) changeStep(step);
      }}
    >
      {DESIGN_WORKFLOW_STEPS.map((step, index) => (
        <option key={step} value={step}>
          {index + 1}/4 {STEP_META[step].label}
          {step === "images" || step === "brief" ? ` · ${STATUS_LABELS[statuses[step]]}` : ""}
        </option>
      ))}
    </select>
  ) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a navigation target requests a step change; a recreated handler must not repeat it.
  useEffect(() => {
    if (!targetSignature || !target) return;
    changeStep(target.step);
  }, [target, targetSignature]);

  useEffect(() => {
    if (!target || activeStep !== target.step) return;
    document.getElementById(target.headingId)?.focus();
  }, [activeStep, target]);

  return (
    <main
      ref={workspaceRoot}
      className="design-workspace-shell"
      data-active-step={activeStep}
      data-compact-correction={compact || undefined}
      aria-label="外观设计工作区"
      style={
        {
          "--design-step-duration": `${UI_MOTION_DURATION_MS}ms`,
          "--design-step-easing": UI_MOTION_EASING,
        } as CSSProperties
      }
    >
      <DesignStepMotion
        root={workspaceRoot}
        step={activeStep}
        compact={compact}
        enabled={retainCorrection}
        reducedMotion={reducedMotion}
      />
      <header className="design-workspace-shell__header" hidden={compact}>
        <h1>外观设计工作台</h1>
        <div className="design-workspace-shell__steps" role="tablist" aria-label="外观设计步骤">
          {DESIGN_WORKFLOW_STEPS.map((step, index) => {
            const meta = STEP_META[step];
            const selected = step === activeStep;
            const tabId = `${tabIdPrefix}-${step}-tab`;
            const panelId = `${tabIdPrefix}-${step}-panel`;
            return (
              <button
                key={step}
                id={tabId}
                type="button"
                title={meta.description}
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={selected ? "is-active" : undefined}
                onClick={() => changeStep(step)}
                onKeyDown={(event) => {
                  const currentIndex = DESIGN_WORKFLOW_STEPS.indexOf(step);
                  const nextIndex =
                    event.key === "ArrowRight"
                      ? (currentIndex + 1) % DESIGN_WORKFLOW_STEPS.length
                      : event.key === "ArrowLeft"
                        ? (currentIndex + DESIGN_WORKFLOW_STEPS.length - 1) %
                          DESIGN_WORKFLOW_STEPS.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? DESIGN_WORKFLOW_STEPS.length - 1
                            : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  focusStep(DESIGN_WORKFLOW_STEPS[nextIndex]!);
                }}
              >
                <span className="design-workspace-shell__step-number">{index + 1}</span>
                <span>
                  <strong>{meta.label}</strong>
                  <small>{meta.description}</small>
                </span>
                {step === "images" || step === "brief" ? (
                  <em data-status={statuses[step]} title={STATUS_LABELS[statuses[step]]}>
                    {STATUS_LABELS[statuses[step]]}
                  </em>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>
      <div className="design-workspace-shell__panels">
        {DESIGN_WORKFLOW_STEPS.map((step) => {
          const tabId = `${tabIdPrefix}-${step}-tab`;
          const panelId = `${tabIdPrefix}-${step}-panel`;
          return (
            <section
              key={step}
              id={panelId}
              role="tabpanel"
              aria-labelledby={tabId}
              hidden={step !== activeStep && (reducedMotion || !retainedSteps.includes(step))}
              aria-hidden={step !== activeStep || undefined}
              inert={step !== activeStep || undefined}
              data-active={step === activeStep}
              data-step={step}
              className="design-workspace-shell__main"
              data-layout="full-width"
            >
              {step === activeStep ||
              (!reducedMotion && retainedSteps.includes(step)) ||
              (step === "correction" && retainCorrection) ? (
                step === "correction" ? (
                  <DesignCorrectionNavigation.Provider value={correctionNavigation}>
                    {bodies[step]}
                  </DesignCorrectionNavigation.Provider>
                ) : (
                  bodies[step]
                )
              ) : null}
            </section>
          );
        })}
      </div>
    </main>
  );
}

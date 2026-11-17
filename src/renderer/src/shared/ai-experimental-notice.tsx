import { Info, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AI_LOCAL_STORAGE_NOTICE,
  AI_OPERATOR_PRIVACY_NOTICE,
} from "../../../shared/ai-correction/policy";
import { isNetworkAiAvailable } from "../../../shared/platform";
import { floatingHelpPosition } from "./floating-help";
import { SpatialPresence } from "./spatial-presence";
import "./ai-experimental-notice.css";

export function AiExperimentalEntry({
  label,
  children,
  iconOnly = false,
}: {
  label: string;
  children: ReactNode;
  iconOnly?: boolean;
}) {
  if (!isNetworkAiAvailable() && (label === "AI 纠错" || label === "小栈AI助手")) return null;
  if (label !== "AI 纠错" && label !== "小栈AI助手" && label !== "Agent CLI") return children;
  return (
    <div className="ai-experimental-entry">
      {children}
      <AiExperimentalNotice feature={label} iconOnly={iconOnly} />
    </div>
  );
}

export function AiExperimentalNotice({
  feature,
  iconOnly = false,
}: {
  feature: string;
  iconOnly?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 40 });
  const inside = (node: EventTarget | null) =>
    node instanceof Node && (trigger.current?.contains(node) || panel.current?.contains(node));
  useLayoutEffect(() => {
    if (!mode || !trigger.current || !panel.current) return;
    const rect = panel.current.getBoundingClientRect();
    setPosition(
      floatingHelpPosition(
        trigger.current.getBoundingClientRect(),
        rect.width,
        rect.height,
        innerWidth,
        innerHeight,
      ),
    );
  }, [mode]);
  useEffect(() => {
    if (!mode) return;
    const close = () => setMode(null);
    const outside = (event: Event) => {
      const node = event.target;
      if (
        !(
          node instanceof Node &&
          (trigger.current?.contains(node) || panel.current?.contains(node))
        )
      )
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const observer = new MutationObserver(() => {
      if (
        !trigger.current?.isConnected ||
        trigger.current.closest("[hidden], [aria-hidden='true'], [data-overflow-hidden]")
      )
        close();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-overflow-hidden"],
    });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [mode]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ai-experimental-badge${iconOnly ? " is-icon-only" : ""}`}
        aria-label={`${feature}实验功能说明`}
        aria-haspopup="dialog"
        aria-expanded={!!mode}
        aria-controls={mode ? id : undefined}
        onMouseEnter={() => setMode((value) => value ?? "hover")}
        onMouseLeave={(event) => {
          if (mode !== "pinned" && !inside(event.relatedTarget)) setMode(null);
        }}
        onFocus={() => setMode((value) => value ?? "hover")}
        onBlur={(event) => {
          if (mode !== "pinned" && !inside(event.relatedTarget)) setMode(null);
        }}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          setMode((value) => (value === "pinned" ? null : "pinned"));
        }}
      >
        {!iconOnly && "实验功能"}
        <Info size={13} aria-hidden="true" />
      </button>
      {createPortal(
        <SpatialPresence>
          {mode ? (
            <div
              ref={panel}
              id={id}
              role="dialog"
              aria-modal="false"
              aria-label={`${feature}实验功能说明`}
              className="ai-experimental-popover"
              style={position}
              onPointerDown={(event) => event.stopPropagation()}
              data-function-rail-owner={
                trigger.current
                  ?.closest("[data-function-rail-scope]")
                  ?.getAttribute("data-function-rail-scope") ?? undefined
              }
              onMouseLeave={(event) => {
                if (mode !== "pinned" && !inside(event.relatedTarget)) setMode(null);
              }}
            >
              <div className="ai-experimental-popover__heading">
                <strong>实验功能说明</strong>
                <button type="button" aria-label="关闭实验功能说明" onClick={() => setMode(null)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              <p>
                本功能处于实验阶段，效果与稳定性仍在持续完善，可能出现遗漏、误判或不准确的内容。
              </p>
              {feature === "Agent CLI" ? (
                <>
                  <p>
                    本功能允许本机 AI Agent 通过命令行连接工作台，按授权范围读取、修改和导出专利。
                    请仅向可信的 Agent
                    授权，并核对操作结果；可在设置中撤销授权，退出软件后授权失效。
                  </p>
                  <p>
                    第三方 Agent 可能将获准材料发送至外部服务。请确认其数据处理与隐私政策，
                    谨慎授权访问未公开专利、商业秘密及个人信息。
                  </p>
                </>
              ) : (
                <>
                  <p>
                    使用时，处理所需的正文、选中文字、您输入的要求及相关对话上下文，会按本次任务从您的设备直接发送至您自行配置的
                    DeepSeek 官方接口。
                  </p>
                  <p>
                    请在使用前确认服务商的数据处理、保存及隐私政策，谨慎提交未公开专利、商业秘密、个人信息等敏感内容，并确保您有权提供相关数据。
                  </p>
                  <p>
                    AI
                    输出仅供辅助参考，不代表专业审查结论。请逐项核实后再采纳；请求可能产生服务商费用。停止任务或关闭面板无法撤回已发送的数据。
                  </p>
                  <p>{AI_OPERATOR_PRIVACY_NOTICE}</p>
                  <p>{AI_LOCAL_STORAGE_NOTICE}</p>
                </>
              )}
              <small>
                {mode === "pinned"
                  ? "已固定 · 再次点击提示符号、点击外部或按 Esc 关闭"
                  : "点击提示符号可固定说明"}
              </small>
            </div>
          ) : null}
        </SpatialPresence>,
        document.body,
      )}
    </>
  );
}

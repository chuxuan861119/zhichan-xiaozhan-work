import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import qqGroupQrCode from "../assets/feedback-qq-group.jpg";

type FeedbackDialogProps = {
  onClose(): void;
};

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

const FEEDBACK_CHANNELS = [
  { label: "邮箱", value: "yyqc861@163.com" },
  { label: "微信", value: "huxiulong777" },
  { label: "QQ群", value: "1126433961" },
] as const;

const VIEWPORT_MARGIN = 8;

function clampPosition(x: number, y: number, panel: HTMLElement | null) {
  if (!panel) return { x, y };
  const rect = panel.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const minX = VIEWPORT_MARGIN;
  const minY = VIEWPORT_MARGIN;
  const maxX = Math.max(minX, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(minY, window.innerHeight - height - VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

/**
 * 非模态“建议与反馈”弹窗：无遮罩、不锁定焦点，
 * 不阻碍后台内容操作；仅支持按住标题栏拖动改变位置，不支持拉伸。
 */
export function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<{ x: number; y: number } | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const copyValue = useCallback(async (value: string) => {
    const writeFallback = () => {
      const holder = document.createElement("textarea");
      holder.value = value;
      holder.setAttribute("readonly", "");
      holder.style.position = "fixed";
      holder.style.opacity = "0";
      document.body.append(holder);
      holder.select();
      document.execCommand("copy");
      holder.remove();
    };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        writeFallback();
      }
    } catch {
      try {
        writeFallback();
      } catch {
        return;
      }
    }
    setCopiedValue(value);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedValue(null), 1600);
  }, []);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const updatePosition = useCallback((next: { x: number; y: number }) => {
    positionRef.current = next;
    setPosition(next);
  }, []);

  // 初次挂载后按面板实际尺寸计算居中位置，避免闪烁。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || position) return;
    const rect = panel.getBoundingClientRect();
    updatePosition(
      clampPosition(
        (window.innerWidth - rect.width) / 2,
        Math.max(VIEWPORT_MARGIN, (window.innerHeight - rect.height) / 3),
        panel,
      ),
    );
  }, [position, updatePosition]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const panel = panelRef.current;
        const target = event.target;
        const isWithinPanel = panel && target instanceof Node && panel.contains(target);
        if (!isWithinPanel && !dragRef.current) return;
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const handleResize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const current = positionRef.current;
      const rect = panel.getBoundingClientRect();
      updatePosition(clampPosition(current?.x ?? rect.left, current?.y ?? rect.top, panel));
    };
    window.addEventListener("resize", handleResize);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", handleResize);
      observer?.disconnect();
    };
  }, [updatePosition]);

  const handleDragMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const nextX = drag.startX + (event.clientX - drag.startClientX);
      const nextY = drag.startY + (event.clientY - drag.startClientY);
      updatePosition(clampPosition(nextX, nextY, panelRef.current));
    },
    [updatePosition],
  );

  const endDrag = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      window.removeEventListener("pointermove", handleDragMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    },
    [handleDragMove],
  );

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // 点击关闭按钮时不触发拖动。
    if ((event.target as HTMLElement).closest(".feedback-dialog__close")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: rect.left,
      startY: rect.top,
    };
    window.addEventListener("pointermove", handleDragMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    event.preventDefault();
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", handleDragMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    },
    [handleDragMove, endDrag],
  );

  return (
    <div
      ref={panelRef}
      className="feedback-dialog"
      role="dialog"
      aria-modal="false"
      aria-label="建议与反馈"
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <header className="feedback-dialog__header" onPointerDown={handleHeaderPointerDown}>
        <h2 className="feedback-dialog__title">建议与反馈</h2>
        <button
          type="button"
          className="feedback-dialog__close"
          aria-label="关闭建议与反馈窗口"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="feedback-dialog__body">
        <p className="feedback-dialog__hint">
          知产小栈 Work 还有许多需要完善的地方。如果您在使用中遇到问题，或觉得哪里不够顺手，
          希望您能告诉我们。我们会认真阅读每一条反馈，尽力把软件做得更好用。
          感谢您愿意花时间，帮助我们一点点改进。
        </p>
        <ul className="feedback-dialog__channels">
          {FEEDBACK_CHANNELS.map((channel) => (
            <li key={channel.label} className="feedback-dialog__channel">
              <span className="feedback-dialog__channel-label">{channel.label}</span>
              <button
                type="button"
                className="feedback-dialog__channel-value"
                title="点击复制"
                aria-label={`复制${channel.label} ${channel.value}`}
                onClick={() => void copyValue(channel.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void copyValue(channel.value);
                  }
                }}
              >
                {channel.value}
              </button>
              <span className="feedback-dialog__channel-copied" aria-live="polite">
                {copiedValue === channel.value ? "已复制" : ""}
              </span>
            </li>
          ))}
        </ul>
        <figure className="feedback-dialog__qr">
          <div className="feedback-dialog__qr-image">
            <img src={qqGroupQrCode} alt="QQ群 1126433961 加群二维码" />
          </div>
          <figcaption>使用 QQ 扫一扫，加入交流群</figcaption>
        </figure>
      </div>
    </div>
  );
}

import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SpatialCollapse } from "../../shared/spatial-collapse";
import "./ai-thinking-feedback.css";

// Keep clocks outside the conditional surface so hiding the panel does not reset the wait.
export function useThinkingActivity(
  active: boolean,
  taskKey: string,
  phase: string | null,
  text: string,
) {
  const records = useRef(
    new Map<string, { started: number; updated: number; phase: string | null; text: string }>(),
  );
  const [{ now }, setClock] = useState(() => ({ now: Date.now() }));
  useEffect(() => {
    if (!active) {
      records.current.delete(taskKey);
      return;
    }
    const time = Date.now();
    const previous = records.current.get(taskKey);
    records.current.set(taskKey, {
      started: previous?.started ?? time,
      updated:
        previous && previous.phase === phase && previous.text === text ? previous.updated : time,
      phase,
      text,
    });
    setClock({ now: time });
  }, [active, taskKey, phase, text]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock({ now: Date.now() }), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const record = records.current.get(taskKey);
  return {
    started: record?.started ?? now,
    elapsed: Math.max(0, Math.floor((now - (record?.started ?? now)) / 1000)),
    quiet: Boolean(record && now - record.updated >= 45_000),
  };
}

export function AiThinkingFeedback({
  label,
  text,
  truncated,
  activity,
  onCopy,
}: {
  label: string;
  text: string;
  truncated: boolean;
  activity: ReturnType<typeof useThinkingActivity>;
  onCopy?: (text: string) => boolean | Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (expanded && text && follow.current && content.current)
      content.current.scrollTop = content.current.scrollHeight;
  }, [expanded, text]);
  return (
    <section className="ai-thinking-feedback" aria-label={label}>
      <div className="ai-thinking-feedback__status">
        <strong role="status">{label}</strong>
        <span className="ai-running-mark ai-running-mark--inline" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <small>已等待 {activity.elapsed} 秒</small>
      </div>
      {activity.quiet ? (
        <p className="ai-thinking-feedback__hint" role="status">
          暂未收到新内容，仍在等待响应。
        </p>
      ) : activity.elapsed >= 30 ? (
        <p className="ai-thinking-feedback__hint">任务尚未完成，您可以切换页面，稍后回来查看。</p>
      ) : null}
      <div className="ai-thinking-feedback__actions">
        <button
          type="button"
          aria-label={expanded ? "折叠思考过程" : "展开思考过程"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? "收起思考过程" : "查看思考过程"}
        </button>
        {text ? (
          <button
            type="button"
            aria-label="复制思考过程"
            title="复制思考过程"
            onClick={() => {
              void (async () => {
                try {
                  const ok = onCopy
                    ? await onCopy(text)
                    : (await window.patentApi.clipboard.writeText(text)).ok;
                  setNotice(ok ? "已复制思考过程" : "复制失败，请展开后手动选择文字复制。");
                } catch {
                  setNotice("复制失败，请展开后手动选择文字复制。");
                }
              })();
            }}
          >
            <Copy size={14} />
          </button>
        ) : null}
      </div>
      {notice ? <small role="status">{notice}</small> : null}
      <SpatialCollapse open={expanded}>
        <div
          className="ai-thinking-feedback__content"
          aria-live="off"
          ref={content}
          data-selectable-tool-text
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
        >
          {truncated ? <small>已省略较早内容，复制包含全部已保留文字。</small> : null}
          {text.length > 20_000 ? <small>显示最近 20000 字符，可复制全部已保留文字。</small> : null}
          {text ? (
            <pre>{text.slice(-20_000)}</pre>
          ) : (
            <p>正在等待模型返回内容；未提供思考过程时，完成后仍会显示结果。</p>
          )}
        </div>
      </SpatialCollapse>
    </section>
  );
}

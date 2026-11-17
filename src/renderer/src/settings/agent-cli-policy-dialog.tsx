import { useEffect, useRef, useState } from "react";
import {
  AGENT_CLI_POLICY_SECTIONS,
  AGENT_CLI_POLICY_TITLE,
  AGENT_CLI_POLICY_VERSION,
} from "../../../shared/automation/policy";
import { StandardDialog } from "../shared/standard-dialog";
import "../shared/ai-data-policy.css";
import "./agent-cli-policy-dialog.css";

export function AgentCliPolicyDialog({
  open,
  onClose,
  onAccept,
}: {
  open: boolean;
  onClose(): void;
  onAccept?: (() => Promise<boolean>) | undefined;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const accepting = useRef(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setReadToEnd(false);
    setAgreed(false);
    setError("");
    const body = dialogRef.current?.querySelector<HTMLElement>(".standard-dialog__body");
    if (!body) return;
    body.scrollTop = 0;
    const measure = () => {
      if (body.clientHeight > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2)
        setReadToEnd(true);
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(body);
    body.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      body.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  async function accept() {
    if (!onAccept || !readToEnd || !agreed || accepting.current) return;
    accepting.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onAccept()) onClose();
      else setError("开启未完成，Agent CLI 未开启，请重试。");
    } catch {
      setError("开启未完成，Agent CLI 未开启，请重试。");
    } finally {
      accepting.current = false;
      setBusy(false);
    }
  }
  return (
    <StandardDialog
      open={open}
      title={AGENT_CLI_POLICY_TITLE}
      subtitle={`版本 ${AGENT_CLI_POLICY_VERSION} · 请重点阅读风险与第三方数据处理说明`}
      size="l"
      portal
      dialogRef={dialogRef}
      closeDisabled={busy}
      onCancel={onClose}
      className="agent-cli-policy-dialog"
      footer={
        onAccept ? (
          <>
            <div className="ai-policy-consent">
              {!readToEnd ? <span>请阅读并滚动至说明底部</span> : null}
              <label>
                <input
                  type="checkbox"
                  checked={agreed}
                  disabled={!readToEnd || busy}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                我已阅读并同意 Agent CLI 使用协议与隐私说明
              </label>
            </div>
            <button type="button" disabled={busy} onClick={onClose}>
              暂不开启
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!readToEnd || !agreed || busy}
              onClick={() => void accept()}
            >
              {busy ? "正在开启…" : "同意并开启"}
            </button>
          </>
        ) : (
          <button type="button" className="primary-button" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      <section className="ai-policy-content">
        {AGENT_CLI_POLICY_SECTIONS.map((section) => (
          <section
            key={section.title}
            className={"important" in section ? "agent-cli-policy-important" : undefined}
          >
            <h3>{section.title}</h3>
            {section.paragraphs.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </section>
        ))}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    </StandardDialog>
  );
}

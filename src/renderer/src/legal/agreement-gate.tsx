import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import heroUrl from "../../../../docs/previews/agreement-consent/assets/patent-hero.png?url";
import type { AgreementState } from "../../../shared/legal/model";
import type { LegalDocument } from "../../../shared/legal/policies";
import { SPATIAL_MOTION_RETENTION_MS } from "../shared/spatial-motion";
import { StandardDialog } from "../shared/standard-dialog";
import { useReducedMotion } from "../shared/use-reduced-motion";
import { LegalPolicyDialog } from "./legal-policy-dialog";
import "../shared/standard-dialog.css";
import "./agreement-gate.css";

export function AgreementGate({ children }: { children: ReactNode }) {
  const api = window.patentApi?.agreements;
  const [state, setState] = useState<AgreementState | null>(null);
  const [blocked, setBlocked] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [participate, setParticipate] = useState(false);
  const [reading, setReading] = useState<LegalDocument | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionPending = useRef(false);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (quitTimer.current) clearTimeout(quitTimer.current);
    };
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (!api) throw new Error("协议确认服务不可用，请重新加载软件。");
      const result = await api.read();
      if (!result.ok) throw new Error(result.error.message);
      if (!mounted.current) return;
      setState(result.value);
      setBlocked(result.value.needsConfirmation);
      setOpen(result.value.needsConfirmation);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "无法读取协议确认记录，请重试。");
        setOpen(true);
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const showDocument = useCallback((document: LegalDocument) => {
    setReading(document);
  }, []);
  const confirm = async () => {
    if (!api || !state || actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError("");
    setBlocked(false);
    setOpen(false);
    try {
      const result = await api.accept({
        appVersion: state.appVersion,
        termsVersion: state.policy.termsVersion,
        privacyVersion: state.policy.privacyVersion,
        ...(state.showStatistics
          ? { participate, statisticsNoticeVersion: state.statistics?.noticeVersion }
          : {}),
      });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.needsConfirmation) throw new Error("协议版本发生变化，请重新读取后确认。");
    } catch (cause) {
      if (mounted.current) {
        setBlocked(true);
        setOpen(true);
        setError(cause instanceof Error ? cause.message : "确认未能保存，请重试。");
      }
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const decline = () => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setOpen(false);
    setError("");
    const exit = async () => {
      quitTimer.current = null;
      try {
        const quit = window.patentApi?.application.requestQuit;
        if (!quit) throw new Error("软件退出入口不可用，请使用系统窗口关闭按钮退出。");
        const result = await quit();
        if (!result.ok) throw new Error(result.error.message);
      } catch (cause) {
        if (mounted.current) {
          setOpen(true);
          setBusy(false);
          setError(cause instanceof Error ? cause.message : "未能退出软件，请重试。");
        }
        actionPending.current = false;
      }
    };
    if (reduced) void exit();
    else quitTimer.current = setTimeout(() => void exit(), SPATIAL_MOTION_RETENTION_MS);
  };
  useEffect(() => {
    const restoreAfterCancelledClose = () => {
      if (!blocked || !actionPending.current) return;
      actionPending.current = false;
      setBusy(false);
      setOpen(true);
      setError("软件退出未完成，请先处理保存问题后重试。");
    };
    window.addEventListener("workbench:application-close-cancelled", restoreAfterCancelledClose);
    return () =>
      window.removeEventListener(
        "workbench:application-close-cancelled",
        restoreAfterCancelledClose,
      );
  }, [blocked]);
  const label =
    state?.reason === "policy-update"
      ? "同意更新并继续"
      : state?.reason === "software-update"
        ? "继续使用"
        : "开始使用";
  const statisticsUnavailable =
    !state?.statistics?.available || state.statistics.status === "error";
  return (
    <>
      <div
        className="agreement-workspace"
        inert={blocked || undefined}
        aria-hidden={blocked || undefined}
      >
        {children}
      </div>
      {loading && !open ? (
        <div className="agreement-loading" role="status">
          正在准备工作台…
        </div>
      ) : null}
      <StandardDialog
        open={open}
        title="软件使用协议与隐私政策确认"
        showClose={false}
        onCancel={() => {}}
        onEscape={() => {}}
        initialFocusRef={headingRef}
        portal
        className={`agreement-gate${state?.showStatistics === false ? " agreement-gate-policies-only" : ""}`}
        bodyClassName="agreement-gate-body"
      >
        <section className="consent-hero">
          <img src={heroUrl} alt="" />
          <div className="consent-brand-copy">
            <p className="consent-brand">
              知产小栈 <span>Work</span>
            </p>
            <p className="consent-eyebrow">本地专利撰写工作台</p>
            <h1 ref={headingRef} tabIndex={-1}>
              让灵感有据，
              <br />
              让撰写有序。
            </h1>
            <p className="consent-description">专注思考，从容撰写。</p>
          </div>
        </section>
        <section className="consent-confirm">
          <div className="consent-confirm-content">
            <p className="consent-guidance">
              {state?.reason === "policy-update"
                ? "请阅读并确认本次协议更新"
                : state?.reason === "software-update"
                  ? "软件已更新，以下协议保持不变"
                  : "开始使用前，请阅读并同意"}
            </p>
            <div className="consent-agreement-links">
              <button type="button" disabled={!state || busy} onClick={() => showDocument("terms")}>
                软件使用协议
              </button>
              <span aria-hidden="true" />
              <button
                type="button"
                disabled={!state || busy}
                onClick={() => showDocument("privacy")}
              >
                隐私政策{state?.reason === "policy-update" ? <small>查看更新</small> : null}
              </button>
            </div>
            {state?.showStatistics ? (
              <div className="consent-statistics">
                <div className="consent-statistics-line">
                  <label>
                    <input
                      type="checkbox"
                      checked={participate}
                      disabled={busy || statisticsUnavailable}
                      onChange={(e) => setParticipate(e.target.checked)}
                      aria-describedby="consent-statistics-summary"
                    />
                    <span>我愿意参与使用统计，支持软件改进</span>
                  </label>
                  <button type="button" disabled={busy} onClick={() => showDocument("statistics")}>
                    查看说明
                  </button>
                </div>
                <p id="consent-statistics-summary">
                  仅统计活跃情况、使用时长区间及软件版本，不收集专利文档等私人内容。
                  {statisticsUnavailable ? "统计服务尚未开放，目前不计时、不上报。" : ""}
                </p>
              </div>
            ) : null}
            {error ? (
              <p className="consent-error" role="alert">
                {error}
                <button type="button" disabled={busy || loading} onClick={() => void refresh()}>
                  重新读取
                </button>
              </p>
            ) : null}
          </div>
          <footer className="consent-footer">
            <p>
              {state?.reason === "software-update"
                ? "本次软件更新未更改协议。"
                : `点击“${label}”，即表示同意${state?.reason === "policy-update" ? "更新后的协议" : "以上协议"}。`}
            </p>
            <div className="consent-actions">
              <button type="button" className="consent-decline" disabled={busy} onClick={decline}>
                {state?.reason === "software-update" ? "退出软件" : "不同意并退出"}
              </button>
              <button
                type="button"
                className={`consent-start ${participate || state?.showStatistics === false ? "consent-start-blue" : ""}`}
                disabled={busy || loading || !state}
                onClick={() => void confirm()}
              >
                {label}
              </button>
            </div>
          </footer>
        </section>
      </StandardDialog>
      <LegalPolicyDialog
        document={reading}
        state={state}
        onClose={() => setReading(null)}
        returnLabel="返回协议确认"
      />
    </>
  );
}

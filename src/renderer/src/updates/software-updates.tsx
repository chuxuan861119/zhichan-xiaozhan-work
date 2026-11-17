import { ArrowUpRight, Download, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { UPDATE_OPEN_EVENT } from "../../../shared/updates/model";
import { MotionPresence, useMotionPresenceClosing } from "../app/motion-presence";
import { StandardDialog } from "../shared/standard-dialog";
import { useSoftwareUpdates } from "./use-software-updates";
import "./software-updates.css";

export function SoftwareUpdates() {
  const { state, check } = useSoftwareUpdates();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = window.patentApi?.updates;
    void api?.start().catch(() => {});
    const show = (event: Event) => {
      setOpen(true);
      setError("");
      if ((event as CustomEvent<{ check?: boolean }>).detail?.check !== false) void check();
    };
    window.addEventListener(UPDATE_OPEN_EVENT, show);
    return () => window.removeEventListener(UPDATE_OPEN_EVENT, show);
  }, [check]);
  const dismiss = async (action: "later" | "skip", close = true) => {
    if (!state.release || busy) return;
    setBusy(true);
    setError("");
    if (close) setOpen(false);
    try {
      const result = await window.patentApi?.updates?.dismiss({
        version: state.release.version,
        action,
      });
      if (!result?.ok) throw Error("dismiss");
    } catch {
      setError("未能保存提醒偏好，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    if (!state.release || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.patentApi?.updates?.openDownload(state.release.version);
      if (!result?.ok) throw Error("download");
    } catch {
      setError("无法打开官方下载页，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  const release = state.release;
  return (
    <>
      {createPortal(
        <MotionPresence kind="panel">
          {state.notification && !open && release ? (
            <UpdateNotice
              version={release.version}
              busy={busy}
              error={error}
              onView={() => {
                setOpen(true);
                setError("");
              }}
              onClose={() => void dismiss("later", false)}
            />
          ) : null}
        </MotionPresence>,
        document.body,
      )}
      <StandardDialog
        open={open}
        portal
        title="软件更新"
        subtitle="每一次改进，都为更顺畅的撰写"
        size="m"
        className="software-update-dialog"
        onCancel={() => {
          if (!busy) {
            if (state.notification && release) void dismiss("later");
            else setOpen(false);
          }
        }}
        closeDisabled={busy}
        footer={
          release ? (
            <>
              <button
                type="button"
                className="update-skip-button"
                disabled={busy || state.status === "checking"}
                onClick={() => void dismiss("skip")}
              >
                跳过此版本
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void dismiss("later")}
              >
                稍后提醒
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || state.status !== "available"}
                onClick={() => void download()}
              >
                <Download size={16} />
                前往官方下载
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={state.status === "checking"}
                onClick={() => void check()}
              >
                {state.status === "checking" ? "正在检查…" : "重新检查"}
              </button>
              <button type="button" className="primary-button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </>
          )
        }
      >
        <div className="update-detail-heading">
          <div className="update-version-card__icon" aria-hidden="true">
            <Sparkles size={26} />
          </div>
          <div>
            <h3>
              {release
                ? `新版本 ${release.version}`
                : state.status === "latest"
                  ? state.message
                  : "保持软件常新"}
            </h3>
            <p>
              当前版本 {state.currentVersion}
              {state.channel === "preview" ? " · 预览通道" : ""}
              {release
                ? ` · ${new Date(release.publishedAt).toLocaleDateString("zh-CN")} 发布`
                : ""}
            </p>
          </div>
        </div>
        <p className="update-detail-status" role="status" aria-live="polite">
          {state.status === "checking" ? (
            <RefreshCw size={16} className="update-check-spinner" aria-hidden="true" />
          ) : null}
          {state.message}
        </p>
        {release && (
          <>
            <section className="update-release-notes">
              <h4>本次更新</h4>
              <ul>
                {[...new Set(release.notes)].map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
            <div className="update-detail-metadata">
              {release.classificationVersion && (
                <span>分类号数据库：{release.classificationVersion}</span>
              )}
              {release.systemRequirement && <span>系统要求：{release.systemRequirement}</span>}
              <span>下载渠道：{new URL(release.downloadUrl).hostname}</span>
            </div>
            <p className="update-install-note">
              将在浏览器中打开官方下载地址。安装前请保存文档并退出软件；此次操作不会自动安装或重启。
            </p>
          </>
        )}
        {error && (
          <p className="update-action-error" role="alert">
            {error}
          </p>
        )}
      </StandardDialog>
    </>
  );
}
function UpdateNotice({
  version,
  busy,
  error,
  onView,
  onClose,
}: {
  version: string;
  busy: boolean;
  error: string;
  onView(): void;
  onClose(): void;
}) {
  const closing = useMotionPresenceClosing();
  return (
    <aside
      className="software-update-notice"
      data-motion={closing ? "exit" : "enter"}
      inert={closing ? true : undefined}
      aria-hidden={closing ? true : undefined}
      aria-label="新版本提醒"
    >
      <button
        className="update-notice-close"
        type="button"
        aria-label="关闭更新提醒"
        disabled={busy}
        onClick={onClose}
      >
        <X size={16} />
      </button>
      <div className="update-notice-heading">
        <Sparkles size={19} aria-hidden="true" />
        <strong>新版本 {version} 已发布</strong>
      </div>
      <p role="status">让撰写更顺畅，查看本次更新内容。</p>
      <button className="update-notice-view" type="button" onClick={onView}>
        查看更新 <ArrowUpRight size={15} />
      </button>
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}

import { useEffect, useState } from "react";
import { StandardDialog } from "../shared/standard-dialog";

/** Other decision dialogs (snapshot failure, unsaved settings) always take precedence. */
export function ApplicationExitProgress({
  phase,
  cancelling,
  onCancel,
}: {
  phase: "editor" | "aggregate" | "backup";
  cancelling: boolean;
  onCancel(): void;
}) {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 1_500);
    const slowTimer = setTimeout(() => setSlow(true), 8_000);
    const check = () =>
      setDecisionOpen(
        Boolean(
          document.querySelector('[aria-modal="true"]:not(.application-exit-progress__dialog)'),
        ),
      );
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal"],
    });
    check();
    return () => {
      clearTimeout(show);
      clearTimeout(slowTimer);
      observer.disconnect();
    };
  }, []);
  // Backup owns its progress/failure controls and only appears when it is actually slow.
  if (!visible || decisionOpen || phase === "backup") return null;
  return (
    <div className="application-exit-progress">
      <StandardDialog
        open
        size="s"
        className="application-exit-progress__dialog"
        title={cancelling ? "正在返回软件" : "正在完成退出"}
        onCancel={slow ? onCancel : () => {}}
        closeDisabled={!slow || cancelling}
        footer={
          slow ? (
            <button type="button" disabled={cancelling} onClick={onCancel}>
              {cancelling ? "正在等待当前操作结束…" : "返回软件"}
            </button>
          ) : undefined
        }
      >
        <p role="status">
          {cancelling
            ? "当前保存操作完成后返回，修改会继续保留。"
            : phase === "editor"
              ? "正在保存最后的编辑内容…"
              : "正在确认文档保存与关闭恢复点…"}
        </p>
      </StandardDialog>
    </div>
  );
}

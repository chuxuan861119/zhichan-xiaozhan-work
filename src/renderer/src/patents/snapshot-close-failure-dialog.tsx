import { useRef } from "react";
import { StandardDialog } from "../shared/standard-dialog";

export type SnapshotCloseDecision = "retry" | "cancel" | "skip";

type SnapshotCloseFailureDialogProps = Readonly<{
  errorMessage: string;
  onDecision(decision: SnapshotCloseDecision): void;
}>;

export function SnapshotCloseFailureDialog({
  errorMessage,
  onDecision,
}: SnapshotCloseFailureDialogProps) {
  const decided = useRef(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const decide = (decision: SnapshotCloseDecision) => {
    if (decided.current) return;
    decided.current = true;
    onDecision(decision);
  };

  return (
    <StandardDialog
      open
      title="关闭恢复点创建失败"
      size="s"
      dialogRole="alertdialog"
      onCancel={() => decide("cancel")}
      closeLabel="关闭提示"
      initialFocusRef={retryButton}
      footer={
        <>
          <button ref={retryButton} type="button" onClick={() => decide("retry")}>
            重试创建快照
          </button>
          <button type="button" onClick={() => decide("cancel")}>
            取消关闭
          </button>
          <button type="button" className="primary-button" onClick={() => decide("skip")}>
            仍然关闭
          </button>
        </>
      }
    >
      <p>正文及编辑内容已经安全保存，但本次关闭恢复点未能创建。</p>
      <p className="standard-dialog__danger-message">{errorMessage}</p>
    </StandardDialog>
  );
}

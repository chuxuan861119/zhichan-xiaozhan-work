import { useRef } from "react";
import { StandardDialog } from "../../shared/standard-dialog";

type BodyNumberConflictDialogProps = Readonly<{
  number: number;
  contexts: readonly string[];
  onCancel(): void;
  onConfirm(): void;
}>;

export function BodyNumberConflictDialog({
  number,
  contexts,
  onCancel,
  onConfirm,
}: BodyNumberConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <StandardDialog
      open
      portal
      title="序号已在正文中出现"
      size="s"
      className="reference-mark-interruption-dialog"
      closeLabel="关闭序号冲突提示"
      onCancel={onCancel}
      initialFocusRef={cancelButtonRef}
      dialogRef={dialogRef}
      footer={
        <>
          <button ref={cancelButtonRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary-button" onClick={onConfirm}>
            仍使用序号 {number}
          </button>
        </>
      }
    >
      <p>
        序号 {number} 已在权利要求书其他位置出现。它可能是尚未登记的附图标记，也可能只是技术参数。
      </p>
      {contexts.length > 0 ? (
        <ol className="reference-mark-interruption-dialog__contexts">
          {contexts.map((context, index) => (
            <li key={context}>
              <span>位置 {index + 1}：</span>
              <q>{context}</q>
            </li>
          ))}
        </ol>
      ) : null}
      <p>请核对上述位置。继续后，正文中可能出现相同序号对应不同关键词的情况。</p>
    </StandardDialog>
  );
}

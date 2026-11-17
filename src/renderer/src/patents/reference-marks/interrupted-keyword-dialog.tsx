import { useRef } from "react";
import { StandardDialog } from "../../shared/standard-dialog";

export type InterruptedKeywordDecision = "keep" | "repair" | "cancel";

type InterruptedKeywordDialogProps = Readonly<{
  keyword: string;
  number: number;
  matchCount: number;
  examples: readonly string[];
  contexts: readonly string[];
  onDecision(decision: InterruptedKeywordDecision): void;
}>;

export function InterruptedKeywordDialog({
  keyword,
  number,
  matchCount,
  examples,
  contexts,
  onDecision,
}: InterruptedKeywordDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <StandardDialog
      open
      portal
      title="检查相似附图标记"
      size="s"
      className="reference-mark-interruption-dialog"
      closeLabel="关闭相似附图标记提示"
      onCancel={() => onDecision("cancel")}
      initialFocusRef={keepButtonRef}
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" onClick={() => onDecision("cancel")}>
            取消
          </button>
          <button ref={keepButtonRef} type="button" onClick={() => onDecision("keep")}>
            仅编号当前关键词
          </button>
          <button type="button" className="primary-button" onClick={() => onDecision("repair")}>
            同时修复 {matchCount} 处
          </button>
        </>
      }
    >
      <p>
        另有 {matchCount} 处“{keyword}”被已有编号打断，可能是同一个关键词。
      </p>
      {examples.length > 0 ? (
        <div className="reference-mark-interruption-dialog__examples">
          <span>检测到：</span>
          {examples.map((example) => (
            <code key={example}>{example}</code>
          ))}
        </div>
      ) : null}
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
      <p>
        是否同时改为“{keyword}({number})”？不会修改其他已登记的更长关键词。
      </p>
    </StandardDialog>
  );
}

import { useMemo, useState } from "react";
import type { DraftSummary } from "../../../shared/ipc/contract";
import { StandardDialog } from "../shared/standard-dialog";

type LegacyMigrationDialogProps = {
  drafts: DraftSummary[];
  onImport(draftId: string): Promise<boolean>;
  onLater(): void;
};

export function LegacyMigrationDialog({ drafts, onImport, onLater }: LegacyMigrationDialogProps) {
  const [selectedDraftIds, setSelectedDraftIds] = useState(
    () => new Set(drafts.map((draft) => draft.draftId)),
  );
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const selectedCount = selectedDraftIds.size;
  const sortedDrafts = useMemo(
    () => drafts.slice().sort((left, right) => right.savedAt.localeCompare(left.savedAt)),
    [drafts],
  );

  const toggleDraft = (draftId: string) => {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      if (next.has(draftId)) next.delete(draftId);
      else next.add(draftId);
      return next;
    });
  };

  const importSelected = async () => {
    setBusy(true);
    try {
      let imported = 0;
      for (const draftId of selectedDraftIds) {
        if (await onImport(draftId)) imported += 1;
      }
      if (imported > 0) setCompleted(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StandardDialog
      open
      title="旧草稿迁移"
      subtitle="检测到旧版本自动保存草稿。导入会复制到内部文档库，原草稿文件默认保留。"
      size="l"
      onCancel={onLater}
      closeDisabled={busy}
      bodyClassName="legacy-migration-dialog__body"
      footer={
        <>
          <button
            type="button"
            onClick={() => setSelectedDraftIds(new Set(drafts.map((draft) => draft.draftId)))}
            disabled={busy}
          >
            全选
          </button>
          <button type="button" onClick={onLater} disabled={busy}>
            稍后
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void importSelected()}
            disabled={busy || selectedCount === 0}
          >
            导入选中的旧草稿
          </button>
        </>
      }
    >
      {completed ? <p className="migration-success">导入完成，旧草稿仍保留。</p> : null}
      <div className="legacy-draft-list">
        {sortedDrafts.map((draft) => (
          <label key={draft.draftId}>
            <input
              type="checkbox"
              checked={selectedDraftIds.has(draft.draftId)}
              onChange={() => toggleDraft(draft.draftId)}
            />
            <span>{draft.displayName}</span>
            <time>{new Date(draft.savedAt).toLocaleString("zh-CN")}</time>
          </label>
        ))}
      </div>
    </StandardDialog>
  );
}

import { useMemo, useState } from "react";
import {
  PATENT_CUSTOMER_MAX_LENGTH,
  PATENT_NAME_MAX_LENGTH,
  type PatentType,
} from "../../../shared/patent/model";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { StandardDialog } from "../shared/standard-dialog";

type PatentSettingsRequest = {
  name?: string | null;
  customer?: string | null;
  patentType: PatentType;
  terminologyReplacementRequested: boolean;
};

type PatentSettingsDialogProps = {
  busy: boolean;
  name: string | null;
  customer: string | null;
  patentType: PatentType;
  onSave(request: PatentSettingsRequest): void;
  onCancel(): void;
};

const TYPE_LABELS: Record<PatentType, string> = {
  invention: "发明",
  "utility-model": "实用新型",
};

function terminologyPreview(from: PatentType, to: PatentType): string | null {
  if (from === to) return null;
  return `${TYPE_LABELS[from]} → ${TYPE_LABELS[to]}`;
}

export function PatentSettingsDialog({
  busy,
  name,
  customer,
  patentType,
  onSave,
  onCancel,
}: PatentSettingsDialogProps) {
  const [draftName, setDraftName] = useState(name ?? "");
  const [draftCustomer, setDraftCustomer] = useState(customer ?? "");
  const [draftType, setDraftType] = useState<PatentType>(patentType);
  const [terminologyReplacementRequested, setTerminologyReplacementRequested] = useState(false);
  const preview = useMemo(() => terminologyPreview(patentType, draftType), [patentType, draftType]);

  const submit = () => {
    const trimmedName = draftName.trim();
    const trimmedCustomer = draftCustomer.trim();
    const nextName = trimmedName.length > 0 ? trimmedName : null;
    const nextCustomer = trimmedCustomer.length > 0 ? trimmedCustomer : null;
    onSave({
      ...(nextName !== name ? { name: nextName } : {}),
      ...(nextCustomer !== customer ? { customer: nextCustomer } : {}),
      patentType: draftType,
      terminologyReplacementRequested: Boolean(preview && terminologyReplacementRequested),
    });
  };

  return (
    <StandardDialog
      open
      title="专利设置"
      subtitle="名称只影响专利元数据；切换类型不会自动改写正文，除非你勾选术语替换。"
      size="m"
      onCancel={onCancel}
      closeDisabled={busy}
      bodyClassName="patent-dialog-body"
      footer={
        <>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button className="primary-button" type="button" disabled={busy} onClick={submit}>
            保存设置
          </button>
        </>
      }
    >
      <label>
        专利名称
        <input
          type="text"
          value={draftName}
          disabled={busy}
          maxLength={PATENT_NAME_MAX_LENGTH}
          placeholder="选填"
          onChange={(event) => setDraftName(event.currentTarget.value)}
        />
      </label>
      <label>
        所属客户
        <input
          type="text"
          value={draftCustomer}
          disabled={busy}
          maxLength={PATENT_CUSTOMER_MAX_LENGTH}
          placeholder="选填"
          onChange={(event) => setDraftCustomer(event.currentTarget.value)}
        />
      </label>
      <fieldset className="dialog-fieldset">
        <legend>专利类型</legend>
        <label>
          <input
            type="radio"
            name="patent-settings-type"
            disabled={busy}
            checked={draftType === "invention"}
            onChange={() => {
              setDraftType("invention");
              setTerminologyReplacementRequested(false);
            }}
          />
          发明
        </label>
        <label>
          <input
            type="radio"
            name="patent-settings-type"
            disabled={busy}
            checked={draftType === "utility-model"}
            onChange={() => {
              setDraftType("utility-model");
              setTerminologyReplacementRequested(false);
            }}
          />
          实用新型
        </label>
      </fieldset>
      <SpatialCollapse open={Boolean(preview)}>
        {preview ? (
          <section className="terminology-preview" aria-label="术语替换预览">
            <h3>术语替换预览</h3>
            <p>{preview}</p>
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={terminologyReplacementRequested}
                onChange={(event) =>
                  setTerminologyReplacementRequested(event.currentTarget.checked)
                }
              />
              保存后执行全局术语替换
            </label>
          </section>
        ) : null}
      </SpatialCollapse>
    </StandardDialog>
  );
}

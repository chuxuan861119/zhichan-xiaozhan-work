import { useRef, useState } from "react";
import type { PatentCreateRequest } from "../../../shared/ipc/contract";
import {
  PATENT_CUSTOMER_MAX_LENGTH,
  PATENT_NAME_MAX_LENGTH,
  type PatentType,
} from "../../../shared/patent/model";
import { StandardDialog } from "../shared/standard-dialog";

type CreatePatentDialogProps = {
  busy: boolean;
  onCreate(request: PatentCreateRequest): void;
  onCancel(): void;
};

export function CreatePatentDialog({ busy, onCreate, onCancel }: CreatePatentDialogProps) {
  const [name, setName] = useState("");
  const [customer, setCustomer] = useState("");
  const [patentType, setPatentType] = useState<PatentType | null>(null);
  const [typeError, setTypeError] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const submit = (selectedType = patentType) => {
    if (busy) return;
    if (!selectedType) {
      setTypeError(true);
      return;
    }
    const trimmedName = name.trim();
    const trimmedCustomer = customer.trim();
    onCreate({
      patentType: selectedType,
      name: trimmedName.length > 0 ? trimmedName : null,
      customer: trimmedCustomer.length > 0 ? trimmedCustomer : null,
    });
  };

  return (
    <StandardDialog
      open
      title="新建专利"
      subtitle="创建后会自动生成权利要求书、说明书、说明书附图、摘要和摘要附图。"
      size="m"
      onCancel={onCancel}
      closeDisabled={busy}
      initialFocusRef={nameInputRef}
      footer={
        <>
          <button type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            form="create-patent-form"
            disabled={busy}
          >
            {busy ? "创建中…" : "创建专利"}
          </button>
        </>
      }
    >
      <form
        id="create-patent-form"
        className="patent-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        <label>
          专利名称
          <input
            type="text"
            ref={nameInputRef}
            value={name}
            disabled={busy}
            maxLength={PATENT_NAME_MAX_LENGTH}
            placeholder="选填"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          所属客户
          <input
            type="text"
            value={customer}
            disabled={busy}
            maxLength={PATENT_CUSTOMER_MAX_LENGTH}
            placeholder="选填"
            onChange={(event) => setCustomer(event.currentTarget.value)}
          />
        </label>
        <fieldset className="dialog-fieldset" aria-invalid={typeError}>
          <legend>专利类型</legend>
          <label style={{ userSelect: "none" }} onDoubleClick={() => submit("invention")}>
            <input
              type="radio"
              name="patent-type"
              disabled={busy}
              checked={patentType === "invention"}
              onChange={() => {
                setPatentType("invention");
                setTypeError(false);
              }}
            />
            发明
          </label>
          <label style={{ userSelect: "none" }} onDoubleClick={() => submit("utility-model")}>
            <input
              type="radio"
              name="patent-type"
              disabled={busy}
              checked={patentType === "utility-model"}
              onChange={() => {
                setPatentType("utility-model");
                setTypeError(false);
              }}
            />
            实用新型
          </label>
          {typeError ? <p className="field-error">请选择专利类型。</p> : null}
        </fieldset>
      </form>
    </StandardDialog>
  );
}

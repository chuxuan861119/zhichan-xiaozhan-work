import { useId, useState } from "react";

export function BriefFieldLabel({ label }: { label: string }) {
  const parts = /^(.*?)(（(?:条件)?必填）|（选填）)$/u.exec(label);
  return (
    <span className="design-brief-label">
      {parts ? (
        <>
          {parts[2] !== "（选填）" && (
            <span className="design-brief-label__required-mark" aria-hidden="true">
              *
            </span>
          )}
          <span>{parts[1]}</span>
          {parts[2] === "（必填）" ? (
            <span className="design-workspace-shell__visually-hidden">{parts[2]}</span>
          ) : (
            <small
              className="design-brief-label__requirement"
              data-required={parts[2] !== "（选填）"}
            >
              {parts[2]}
            </small>
          )}
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** Limits match the saved model; an oversized paste never replaces the user's draft. */
export function BriefTextField({
  label,
  value,
  onChange,
  max = 2000,
  help,
  placeholder,
  showCount = true,
  autoGrow = false,
  singleLine = false,
  inputRef,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  max?: number;
  help?: string;
  placeholder?: string;
  showCount?: boolean;
  autoGrow?: boolean;
  singleLine?: boolean;
  inputRef?(element: HTMLInputElement | HTMLTextAreaElement | null): void;
}) {
  const id = useId(),
    [error, setError] = useState("");
  const showHelp = Boolean(help || showCount);
  const props = {
    id,
    value,
    maxLength: max,
    placeholder,
    "aria-describedby":
      [showHelp && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined,
    "aria-label": label,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.currentTarget.value.length > max) {
        setError(`最多可填写 ${max} 字，请缩短内容；原有内容未被覆盖。`);
        return;
      }
      setError("");
      onChange(event.currentTarget.value);
    },
    onPaste: (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      const length =
        value.length -
        (target.selectionEnd ?? 0) +
        (target.selectionStart ?? 0) +
        event.clipboardData.getData("text").length;
      if (length > max) {
        event.preventDefault();
        setError(`粘贴后将超过 ${max} 字，请分段整理；原有内容未被覆盖。`);
      } else setError("");
    },
  };
  return (
    <div className="design-brief-field">
      <label htmlFor={id}>
        <BriefFieldLabel label={label} />
      </label>
      {singleLine ? (
        <input {...props} ref={inputRef} />
      ) : (
        <textarea
          {...props}
          className={autoGrow ? "design-brief-field__auto-grow" : undefined}
          rows={autoGrow ? 1 : 3}
          ref={inputRef}
        />
      )}
      {showHelp && (
        <div id={`${id}-help`} className="design-brief-field__help">
          <span>{help}</span>
          {showCount && (
            <small>
              {value.length} / {max}
            </small>
          )}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="design-brief-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

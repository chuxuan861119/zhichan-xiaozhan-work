import { type KeyboardEvent, useId, useState } from "react";
import { SpatialCollapse } from "../shared/spatial-collapse";
import { SpatialPresence } from "../shared/spatial-presence";

type MigrationPasswordStepProps = Readonly<{
  mode: "create" | "unlock";
  password: string;
  confirmPassword?: string;
  passwordHint?: string;
  passwordRecorded?: boolean;
  publicPasswordHint?: string | null;
  disabled?: boolean;
  onPasswordChange: (password: string) => void;
  onConfirmPasswordChange?: (password: string) => void;
  onPasswordHintChange?: (hint: string) => void;
  onPasswordRecordedChange?: (recorded: boolean) => void;
}>;

function passwordStrength(password: string): string {
  const length = [...password].length;
  if (length === 0) return "尚未输入";
  if (length < 12) return "不足 12 个字符";
  const groups = [
    /\p{L}/u.test(password),
    /\p{N}/u.test(password),
    /[^\p{L}\p{N}\s]/u.test(password),
    /\s/u.test(password),
  ].filter(Boolean).length;
  if (length >= 16 && groups >= 3) return "较强";
  if (groups >= 2) return "一般";
  return "较弱";
}

export function MigrationPasswordStep({
  mode,
  password,
  confirmPassword = "",
  passwordHint = "",
  passwordRecorded = false,
  publicPasswordHint = null,
  disabled = false,
  onPasswordChange,
  onConfirmPasswordChange,
  onPasswordHintChange,
  onPasswordRecordedChange,
}: MigrationPasswordStepProps) {
  const passwordId = useId();
  const confirmationId = useId();
  const hintId = useId();
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const inputType = visible ? "text" : "password";

  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock((current) =>
      event.key === "CapsLock" ? !current : event.getModifierState("CapsLock"),
    );
  };

  return (
    <section className="migration-password-step" aria-labelledby={`${passwordId}-heading`}>
      <header className="migration-password-step__heading">
        <div>
          <h3 id={`${passwordId}-heading`}>
            {mode === "create" ? "设置迁移密码" : "输入迁移密码"}
          </h3>
          <p>
            {mode === "create"
              ? "该密码只用于此完整数据包，不会保存在软件中。"
              : "密码仅用于在本机解锁所选数据包。"}
          </p>
        </div>
        <strong className="migration-password-step__badge">密码遗失后无法恢复</strong>
      </header>

      {
        <SpatialPresence>
          {mode === "unlock" && publicPasswordHint ? (
            <aside className="migration-password-step__public-hint">
              <span>数据包中的公开提示</span>
              <p>{publicPasswordHint}</p>
              <small>提示本身不保密，请勿据此输入其他账户密码。</small>
            </aside>
          ) : null}
        </SpatialPresence>
      }

      <div className="migration-password-step__fields">
        <div className="migration-password-step__field">
          <label htmlFor={passwordId}>迁移密码</label>
          <div className="migration-password-step__password-control">
            <input
              id={passwordId}
              type={inputType}
              autoComplete={mode === "create" ? "new-password" : "current-password"}
              value={password}
              disabled={disabled}
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyDown={updateCapsLock}
              onBlur={() => setCapsLock(false)}
            />
            <button
              type="button"
              disabled={disabled}
              aria-label={visible ? "隐藏迁移密码" : "显示迁移密码"}
              aria-pressed={visible}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? "隐藏" : "显示"}
            </button>
          </div>
        </div>

        {
          <SpatialCollapse open={Boolean(mode === "create")} parentGap={14}>
            {mode === "create" ? (
              <div className="migration-password-step__field">
                <label htmlFor={confirmationId}>再次输入迁移密码</label>
                <input
                  id={confirmationId}
                  type={inputType}
                  autoComplete="new-password"
                  value={confirmPassword}
                  disabled={disabled}
                  onChange={(event) => onConfirmPasswordChange?.(event.target.value)}
                  onKeyDown={updateCapsLock}
                  onBlur={() => setCapsLock(false)}
                />
              </div>
            ) : null}
          </SpatialCollapse>
        }
      </div>

      {
        <SpatialPresence>
          {capsLock ? (
            <p className="migration-password-step__caps-lock" role="status">
              大写锁定已开启
            </p>
          ) : null}
        </SpatialPresence>
      }
      <p className="migration-password-step__strength">密码强度：{passwordStrength(password)}</p>

      {mode === "create" ? (
        <>
          <div className="migration-password-step__field">
            <label htmlFor={hintId}>密码提示（可选）</label>
            <input
              id={hintId}
              type="text"
              value={passwordHint}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => onPasswordHintChange?.(event.target.value)}
            />
            <small>密码提示不加密，请勿填写密码本身、客户名或可直接推断密码的信息。</small>
          </div>
          <label className="migration-password-step__recorded">
            <input
              type="checkbox"
              checked={passwordRecorded}
              disabled={disabled}
              onChange={(event) => onPasswordRecordedChange?.(event.target.checked)}
            />
            我已记录并妥善保管迁移密码
          </label>
        </>
      ) : null}
    </section>
  );
}

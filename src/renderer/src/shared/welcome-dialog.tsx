import { ChevronRight } from "lucide-react";
import { APPLICATION_NAME } from "../../../shared/branding";
import { BrandLogo } from "./brand-logo";
import { StandardDialog } from "./standard-dialog";

type WelcomeDialogProps = {
  busy: boolean;
  canRestoreFullData: boolean;
  onClose(): void;
  onRestoreFullData(): void;
};

export function WelcomeDialog({
  busy,
  canRestoreFullData,
  onClose,
  onRestoreFullData,
}: WelcomeDialogProps) {
  return (
    <StandardDialog
      open
      title={`欢迎使用${APPLICATION_NAME}`}
      subtitle="本机数据将安全保存在本地"
      size="m"
      onCancel={onClose}
      closeDisabled={busy}
      closeLabel="关闭欢迎提示"
    >
      <div className="welcome-dialog__content">
        <BrandLogo className="welcome-dialog__logo" />
        {canRestoreFullData ? (
          <button
            type="button"
            className="welcome-dialog__restore"
            aria-label="已有完整数据包？从旧电脑恢复"
            disabled={busy}
            onClick={onRestoreFullData}
          >
            <span className="welcome-dialog__restore-context">已有完整数据包？</span>
            <span className="welcome-dialog__restore-title">从旧电脑恢复完整数据</span>
            <ChevronRight
              className="welcome-dialog__restore-icon"
              size={22}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>
    </StandardDialog>
  );
}

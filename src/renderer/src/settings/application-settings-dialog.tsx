import { useRef } from "react";
import { MotionPresence, useMotionPresenceClosing } from "../app/motion-presence";
import { DialogCloseIcon } from "../shared/dialog-close-icon";
import { useModalDialog } from "../shared/use-modal-dialog";
import type { ApplicationSettingsWorkspaceProps } from "./application-settings-workspace";
import { ApplicationSettingsWorkspace } from "./application-settings-workspace";
import {
  type SettingsCloseRegistrar,
  SettingsDraftProvider,
  useSettingsClose,
} from "./settings-drafts";

type ApplicationSettingsDialogProps = {
  open: boolean;
  onClose(): void;
  workspaceProps?: ApplicationSettingsWorkspaceProps;
  closeGuardRegistrar?: SettingsCloseRegistrar;
};

export function ApplicationSettingsDialog(props: ApplicationSettingsDialogProps) {
  return (
    <MotionPresence clearSensitiveInputs>
      {props.open ? (
        <SettingsDraftProvider
          onClose={props.onClose}
          {...(props.closeGuardRegistrar ? { closeGuardRegistrar: props.closeGuardRegistrar } : {})}
        >
          <SettingsDialogContents {...props} />
        </SettingsDraftProvider>
      ) : null}
    </MotionPresence>
  );
}

function SettingsDialogContents({ open, workspaceProps }: ApplicationSettingsDialogProps) {
  const closing = useMotionPresenceClosing();
  const onClose = useSettingsClose();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalDialog({
    open: open && !closing,
    onClose,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
  });
  if (!open) return null;

  return (
    <div
      className="application-settings-dialog application-settings-dialog--workspace"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      ref={dialogRef}
    >
      <div className="application-settings-dialog__backdrop" aria-hidden="true" />
      <section className="application-settings-dialog__surface application-settings-dialog__surface--workspace">
        <header className="application-settings-dialog__header">
          <div className="application-settings-dialog__header-title">
            <h2>设置</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close-button dialog-close-control"
            onClick={onClose}
            aria-label="关闭设置"
          >
            <DialogCloseIcon />
          </button>
        </header>
        <ApplicationSettingsWorkspace {...workspaceProps} onCloseWorkspace={onClose} />
      </section>
    </div>
  );
}

import type { ReactNode } from "react";
import { SpatialView } from "../shared/spatial-view";
import { StandardDialog } from "../shared/standard-dialog";

export type DataTransferDialogStep = Readonly<{
  id: string;
  label: string;
}>;

type DataTransferDialogProps = Readonly<{
  open: boolean;
  steps: readonly DataTransferDialogStep[];
  currentStep: string;
  cancellable: boolean;
  locked?: boolean;
  onClose?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}>;

export function DataTransferDialog({
  open,
  steps,
  currentStep,
  cancellable,
  locked = false,
  onClose,
  onCancel,
  children,
}: DataTransferDialogProps) {
  const currentIndex = steps.findIndex((step) => step.id === currentStep);
  const canCancel = !locked && cancellable && Boolean(onCancel);
  const canClose = !locked && !cancellable && Boolean(onClose);
  const requestExit = () => {
    if (canCancel) onCancel?.();
    else if (canClose) onClose?.();
  };

  const exitLabel = canCancel ? "取消迁移" : canClose ? "关闭完整数据迁移" : null;
  return (
    <StandardDialog
      open={open}
      title="完整数据迁移"
      subtitle="在两台电脑之间安全迁移完整专利库和可移植设置。"
      size="xl"
      onCancel={requestExit}
      showClose={exitLabel !== null}
      closeDisabled={exitLabel === null}
      {...(exitLabel ? { closeLabel: exitLabel } : {})}
      className="data-transfer-dialog"
      bodyClassName="data-transfer-dialog__layout"
    >
      <nav className="data-transfer-dialog__steps" aria-label="迁移步骤">
        <ol>
          {steps.map((step, index) => {
            const stepState =
              index === currentIndex ? "current" : index < currentIndex ? "completed" : "upcoming";
            return (
              <li
                key={step.id}
                data-state={stepState}
                aria-current={index === currentIndex ? "step" : undefined}
              >
                <span aria-hidden="true">{index + 1}</span>
                {step.label}
              </li>
            );
          })}
        </ol>
      </nav>
      <main className="data-transfer-dialog__content">
        <SpatialView viewKey={currentStep}>{children}</SpatialView>
      </main>
    </StandardDialog>
  );
}

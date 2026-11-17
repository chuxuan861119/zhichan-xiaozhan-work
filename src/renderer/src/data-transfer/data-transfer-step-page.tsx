import { type ReactNode, useEffect, useId, useRef } from "react";

type DataTransferStepPageProps = Readonly<{
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "locked";
}>;

type DataTransferWizardActionsProps = Readonly<{
  onBack?: () => void;
  onNext?: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextDisabledReason?: string;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
}>;

export function DataTransferStepPage({
  title,
  description,
  children,
  footer,
  tone = "default",
}: DataTransferStepPageProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <section className="data-transfer-step-page" aria-labelledby={titleId} data-tone={tone}>
      <header className="data-transfer-step-page__header">
        <h3 id={titleId} ref={titleRef} tabIndex={-1}>
          {title}
        </h3>
        {description ? <p className="data-transfer-step-page__description">{description}</p> : null}
      </header>
      <div className="data-transfer-step-page__body">{children}</div>
      {footer ? <footer className="data-transfer-step-page__footer">{footer}</footer> : null}
    </section>
  );
}

export function DataTransferWizardActions({
  onBack,
  onNext,
  backDisabled = false,
  nextDisabled = false,
  nextDisabledReason,
  secondaryActions,
  primaryAction,
}: DataTransferWizardActionsProps) {
  return (
    <div className="data-transfer-wizard-actions">
      {nextDisabled && nextDisabledReason ? (
        <p className="data-transfer-wizard-actions__hint" role="status">
          {nextDisabledReason}
        </p>
      ) : null}
      <div className="data-transfer-wizard-actions__row">
        <div className="data-transfer-wizard-actions__group data-transfer-wizard-actions__group--back">
          {onBack ? (
            <button
              type="button"
              className="data-transfer-wizard-actions__back"
              disabled={backDisabled}
              onClick={onBack}
            >
              上一步
            </button>
          ) : null}
        </div>
        <div className="data-transfer-wizard-actions__group data-transfer-wizard-actions__group--forward">
          {secondaryActions}
          {primaryAction}
          {onNext ? (
            <button
              type="button"
              className="primary-button"
              disabled={nextDisabled}
              onClick={onNext}
            >
              下一步
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

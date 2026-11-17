import { type ReactNode, type RefObject, useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMotionPresenceClosing } from "../app/motion-presence";
import { DialogCloseIcon } from "./dialog-close-icon";
import { DialogResizeHandles } from "./dialog-resize-handles";
import { useRetainedTransientVisibility } from "./transient-function-rail-slot";
import { useDialogDrag } from "./use-dialog-drag";
import { useModalDialog } from "./use-modal-dialog";

export type StandardDialogSize = "s" | "m" | "l" | "xl";

type StandardDialogProps = {
  open: boolean;
  title: string;
  titleSuffix?: ReactNode;
  subtitle?: string;
  size?: StandardDialogSize;
  dialogRole?: "dialog" | "alertdialog";
  onCancel: () => void;
  onEscape?: () => void;
  showClose?: boolean;
  movable?: boolean;
  modeless?: boolean;
  /**
   * Mount the overlay under `document.body` instead of the caller's subtree.
   * Needed whenever the calling subtree sits in a stacking context (e.g. the
   * absolutely positioned CAD tool pane with `z-index: 1`): no `z-index` can
   * escape an ancestor context, so a pane header or rail would otherwise paint
   * over the dialog and receive clicks meant for its backdrop.
   */
  portal?: boolean;
  resizable?: boolean;
  topInset?: number;
  closeDisabled?: boolean;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
  dialogRef?: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
};

export function StandardDialog({
  open: requestedOpen,
  title,
  titleSuffix,
  subtitle,
  size = "m",
  dialogRole = "dialog",
  onCancel,
  onEscape,
  showClose = true,
  movable = false,
  modeless = false,
  portal = false,
  resizable = false,
  topInset = 0,
  closeDisabled = false,
  closeLabel,
  initialFocusRef,
  className,
  bodyClassName,
  dialogRef,
  footer,
  headerActions,
  children,
}: StandardDialogProps) {
  const closing = useMotionPresenceClosing();
  const open = requestedOpen && !closing;
  const internalDialogRef = useRef<HTMLDivElement>(null);
  const [sizeOverride, setSizeOverride] = useState<{ width: number; height: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const titleId = useId();
  const subtitleId = useId();
  const drag = useDialogDrag<HTMLDivElement>({
    positionKey: `standard:${title}`,
    movable,
    stackable: open && modeless,
    minTop: topInset,
  });
  const setDialogRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalDialogRef.current = node;
      if (dialogRef) dialogRef.current = node;
      drag.surfaceRef.current = node;
    },
    [dialogRef, drag.surfaceRef],
  );
  const containerRef = dialogRef ?? internalDialogRef;

  useModalDialog({
    open: open && !modeless,
    onClose: onEscape ?? onCancel,
    containerRef,
    ...(initialFocusRef ? { initialFocusRef } : {}),
    escapeEnabled: !closeDisabled,
  });

  const visible = useRetainedTransientVisibility(open);
  if (!visible) return null;

  const dialog = (
    <div
      className={
        modeless
          ? "standard-dialog-overlay standard-dialog-overlay--modeless dialog-layer--modeless"
          : "standard-dialog-overlay dialog-layer--modal"
      }
      data-motion={open ? "enter" : "exit"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      style={{ ...(modeless ? drag.layerStyle : {}), ...(topInset ? { top: topInset } : {}) }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole lint/a11y/noStaticElementInteractions: dialogRole is restricted to dialog and alertdialog. */}
      <div
        ref={setDialogRef}
        className={`standard-dialog standard-dialog--${size}${movable ? " standard-dialog--movable dialog-surface--floating" : ""}${resizable ? " standard-dialog--resizable" : ""}${className ? ` ${className}` : ""}`}
        style={{ ...(movable ? drag.style : {}), ...(resizable ? sizeOverride : {}) }}
        data-resizing={resizing}
        onPointerDownCapture={modeless ? drag.bringToFront : undefined}
        onKeyDown={
          modeless
            ? (event) => {
                if (
                  event.key === "Escape" &&
                  !event.nativeEvent.isComposing &&
                  !event.defaultPrevented &&
                  !closeDisabled &&
                  drag.isTopmost()
                ) {
                  event.stopPropagation();
                  (onEscape ?? onCancel)();
                }
              }
            : undefined
        }
        role={dialogRole}
        aria-modal={!modeless}
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <header
          className={`standard-dialog__header${movable ? " dialog-titlebar--draggable" : ""}`}
          ref={movable ? drag.titleBarRef : undefined}
        >
          <div className="standard-dialog__heading">
            <h2 id={titleId} className="standard-dialog__title">
              {title}
              {titleSuffix}
            </h2>
            {subtitle ? (
              <p id={subtitleId} className="standard-dialog__subtitle">
                {subtitle}
              </p>
            ) : null}
          </div>
          {headerActions}
          {showClose ? (
            <button
              className="standard-dialog__close dialog-close-control"
              type="button"
              aria-label={closeLabel ?? `关闭${title}`}
              onClick={onCancel}
              disabled={closeDisabled}
            >
              <DialogCloseIcon />
            </button>
          ) : null}
        </header>
        <div className={`standard-dialog__body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
          {children}
        </div>
        {footer ? <footer className="standard-dialog__footer">{footer}</footer> : null}
        {resizable && (
          <DialogResizeHandles
            drag={drag}
            setSize={setSizeOverride}
            setResizing={setResizing}
            label={title}
            minTop={topInset}
          />
        )}
      </div>
    </div>
  );
  return modeless || portal ? createPortal(dialog, document.body) : dialog;
}

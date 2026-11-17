declare global {
  interface Window {
    workbenchUi: {
      motionDuration(distance: number): number;
      dropdownDuration(height: number, clip: string, open: boolean): number;
      panelDuration: number;
      fixedDurations: {
        panel: number;
        dropdown: number;
        libraryEditor: number;
        functionRail: number;
        windowsContentEdit: number;
        workspacePhase: number;
        tableSection: number;
        tabDragReturn: number;
        tabDragSettle: number;
      };
      observe(options: { selector: string; menuSelector?: string }): () => void;
    };
  }
}

/** Keep third-party UI paint in the same policy without changing editor state. */
export function installExternalSurfaceMotion(): () => void {
  return window.workbenchUi.observe({
    selector: [
      '[class*="Dialog-module_dialog__"]',
      '[class*="InfoModal-module_infoModalWindow__"]',
      '[class*="Select-module_dropdownList__"] .MuiPaper-root',
      '[class*="NaturalAnaloguePicker-module_dropdownPaper__"]',
      ".contexify",
      ".MuiMenu-paper",
      ".MLK__variant-panel",
    ].join(","),
    menuSelector:
      '.MuiPaper-root,[class*="dropdown"],.contexify,.MuiMenu-paper,.MLK__variant-panel',
  });
}

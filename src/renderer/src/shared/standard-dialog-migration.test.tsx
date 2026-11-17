/// <reference types="node" />

import { readFileSync } from "node:fs";

const EXCLUDED_PROFESSIONAL_EDITOR_FILES = [
  "src/renderer/src/editor/chemistry-dialog.tsx",
  "src/renderer/src/chemistry/ketcher-editor.tsx",
  "src/renderer/src/editor/ui/chemical-periodic-panel.tsx",
  "src/renderer/src/editor/ui/chemical-suggestion-bar.tsx",
  "src/renderer/src/editor/ui/chemical-structure-tools.tsx",
  "src/renderer/src/editor/ui/formula-dialog.tsx",
] as const;

const STANDARD_DIALOG_MIGRATION_FILES = [
  "src/renderer/src/backup/backup-runtime-coordinator.tsx",
  "src/renderer/src/data-transfer/data-transfer-dialog.tsx",
  "src/renderer/src/exports/export-report-dialog.tsx",
  "src/renderer/src/exports/print-center.tsx",
  "src/renderer/src/shared/figure-export-dialog.tsx",
  "src/renderer/src/shared/figure-replacement-dialog.tsx",
  "src/renderer/src/flowcharts/flowchart-workspace.tsx",
  "src/renderer/src/library/legacy-migration-dialog.tsx",
  "src/renderer/src/patents/create-patent-dialog.tsx",
  "src/renderer/src/patents/custom-dual-view-dialog.tsx",
  "src/renderer/src/patents/editors/formula-figure-insert-dialog.tsx",
  "src/renderer/src/patents/patent-context.tsx",
  "src/renderer/src/patents/patent-export-dialog.tsx",
  "src/renderer/src/patents/patent-library-picker-dialog.tsx",
  "src/renderer/src/patents/patent-settings-dialog.tsx",
  "src/renderer/src/patents/reference-marks/reference-mark-panel.tsx",
  "src/renderer/src/patents/snapshot-close-failure-dialog.tsx",

  "src/renderer/src/settings/backup-manager.tsx",
  "src/renderer/src/settings/patent-template-catalog-settings.tsx",
  "src/renderer/src/settings/snapshot-manager.tsx",
  "src/renderer/src/settings/snapshot-preview/snapshot-content-preview-dialog.tsx",
  "src/renderer/src/shared/about-dialog.tsx",
  "src/renderer/src/shared/welcome-dialog.tsx",
] as const;

const SETTINGS_XL_EXCEPTION = "src/renderer/src/settings/application-settings-dialog.tsx";

test("shares the operation failure shell for all simple error prompts", () => {
  for (const path of [
    "shared/error-dialog.tsx",
    "shared/app-dialog.tsx",
    "editor/ui/formula-dialog.tsx",
  ]) {
    expect(readFileSync(`src/renderer/src/${path}`, "utf8")).toContain("<OperationFeedbackOverlay");
  }
});

test("keeps the excluded chemistry and formula editors outside the shared dialog migration", () => {
  for (const path of EXCLUDED_PROFESSIONAL_EDITOR_FILES) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toMatch(/standard-dialog(?:\.css)?/u);
  }
});

test("keeps every migrated application dialog connected to the standard shell", () => {
  for (const path of STANDARD_DIALOG_MIGRATION_FILES) {
    const source = readFileSync(path, "utf8");
    expect(source, path).toMatch(
      /import\s+\{\s*StandardDialog\s*\}\s+from\s+["'][^"']*standard-dialog["']/u,
    );
  }
});

test("keeps the fixed settings workspace as the single named XL shell exception", () => {
  const source = readFileSync(SETTINGS_XL_EXCEPTION, "utf8");
  expect(source).toContain("application-settings-dialog--workspace");
  expect(source).toContain('aria-label="设置"');
  expect(source).not.toMatch(/standard-dialog/u);
});

test("flowchart output delegates to the shared export and replacement shells", () => {
  const source = readFileSync("src/renderer/src/flowcharts/flowchart-export-dialog.tsx", "utf8");
  for (const component of ["FigureExportDialog", "FigureReplacementDialog"]) {
    expect(source).toContain(`import { ${component} }`);
    expect(source).toContain(`<${component}`);
  }
});

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

if (process.platform !== "darwin") throw new Error("Run this verification on macOS.");
// The app canonicalizes Apple's /var alias at its entry point. Test fixtures that
// invoke low-level filesystem guards directly need the same canonical temp base.
const env = { ...process.env, TMPDIR: realpathSync(tmpdir()) };
function run(command, args) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("npm", ["run", "typecheck"]);
run("npm", [
  "run",
  "test:unit",
  "--",
  "src/main/platform",
  "src/main/ai-correction/endpoint-policy.test.ts",
  "src/main/ai-correction/ai-credential-vault.test.ts",
  "src/main/ai-correction/upload-consent.test.ts",
  "src/main/ai-correction/register-ai-correction-ipc.test.ts",
  "src/main/index.test.ts",
  "src/main/assets/drawing-runtime.test.ts",
  "src/main/assets/drawing-importer.test.ts",
  "src/main/assets/drawing-import-cancellation.test.ts",
  "src/main/documents/document-registry.test.ts",
  "src/main/documents/file-service.test.ts",
  "src/main/documents/patent-bundle-service.test.ts",
  "src/main/open-path-authorization.test.ts",
  "src/main/single-instance.test.ts",
  "src/main/settings/startup-service.test.ts",
  "src/main/shortcuts/shortcut-service.test.ts",
  "src/main/ipc/register-ipc-session.test.ts",
  "src/main/exports/print-service.test.ts",
  "src/main/window.test.ts",
  "src/main/application-lifecycle.test.ts",
  "src/main/library/library-paths.test.ts",
  "src/main/library/library-migration-service.test.ts",
  "src/main/library/snapshot-service.test.ts",
  "src/main/data-transfer/import-staging-validator.test.ts",
  "src/main/data-transfer/library-import-swap-coordinator.test.ts",
  "src/main/data-transfer/drawing-backup-roundtrip.test.ts",
  "src/main/logging/safe-log.test.ts",
  "src/main/licenses/license-audit.test.ts",
  "src/main/packaging/packaging-config.test.ts",
  "src/shared/settings/shortcuts.test.ts",
  "src/shared/platform.test.ts",
  "src/shared/document/platform-fonts.test.ts",
  "src/shared/branding.test.ts",
  "scripts/build-info.test.ts",
]);
run(process.execPath, [
  "--test",
  "scripts/audit-drawing-converter.test.mjs",
  "scripts/package-boundary.test.cjs",
  "scripts/mac-release-policy.test.mjs",
  "scripts/mac-bundle-metadata.test.cjs",
  "scripts/audit-mac-tools.test.mjs",
  "scripts/audit-licenses.test.mjs",
]);

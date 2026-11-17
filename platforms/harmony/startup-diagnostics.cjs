const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
// Keep runtime reports in a recognized cache, outside the user-data inventory.
// Preserve the previous launcher's recognized report when upgrading a local HAP.
module.exports = function startupDiagnostics(data) {
  const directory = path.join(data, "Cache", "harmony-diagnostics");
  fs.mkdirSync(directory, { recursive: true });
  const legacy = path.join(data, "harmony-startup.json");
  if (fs.existsSync(legacy)) {
    const info = fs.lstatSync(legacy);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) {
      let report;
      try {
        report = JSON.parse(fs.readFileSync(legacy, "utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (
        report &&
        ["openharmony", "ohos"].includes(report.platform) &&
        typeof report.source?.buildId === "string" &&
        typeof report.startedAt === "string" &&
        Array.isArray(report.windows) &&
        Array.isArray(report.errors)
      )
        fs.renameSync(legacy, path.join(directory, `previous-startup-${randomUUID()}.json`));
    }
  }
  return directory;
};

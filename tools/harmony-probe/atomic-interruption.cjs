// Three launches: abort immediately before rename; verify, then abort just after
// rename; finally verify the complete replacement. Only synthetic sandbox files.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { app } = require("electron");
const atomic = require("./atomic-adapted.cjs");
const directory = path.join(app.getPath("userData"), "atomic-interruption-v1");
fs.mkdirSync(directory, { recursive: true });
const marker = path.join(directory, "state.json");
const file = path.join(directory, "测试专利.txt");
const oldData = "旧专利内容\n".repeat(10000);
const newData = "新专利内容\n".repeat(10000);
const state = fs.existsSync(marker)
  ? JSON.parse(fs.readFileSync(marker, "utf8"))
  : { phase: 0, checks: [] };
function persist() {
  atomic.sync(marker, JSON.stringify(state, null, 2), { fsync: true });
  console.log(`Harmony interruption state: ${marker} phase=${state.phase}`);
}
if (state.phase === 0) {
  atomic.sync(file, oldData, { fsync: true });
  state.phase = 1;
  persist();
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === file) process.abort();
    return rename(source, destination);
  };
  atomic.sync(file, newData, { fsync: true });
} else if (state.phase === 1) {
  assert.equal(fs.readFileSync(file, "utf8"), oldData);
  state.checks.push("before-rename abort: previous file remains byte-for-byte intact");
  state.phase = 2;
  persist();
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (destination === file) process.abort();
  };
  atomic.sync(file, newData, { fsync: true });
} else {
  assert.equal(fs.readFileSync(file, "utf8"), newData);
  state.checks.push("after-rename abort: replacement file remains byte-for-byte intact");
  state.phase = 3;
  state.finishedAt = new Date().toISOString();
  state.unverified = ["power-loss", "directory-fsync", "real-device", "production-save-recovery"];
  persist();
  app.exit(0);
}

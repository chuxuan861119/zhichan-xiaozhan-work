// HAP launchers do not need to forward a command-line output directory.
const { app } = require("electron");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

if (process.argv.includes("--output")) {
  throw new Error("The HAP entry only writes reports inside its application sandbox.");
}
const reportRoot = join(app.getPath("userData"), "dependency-probe-reports");
mkdirSync(reportRoot, { recursive: true });
const output = join(reportRoot, randomUUID());
console.log(`Harmony dependency probe report directory: ${output}`);
process.argv.push("--output", output);
require("./main.cjs");

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { dialog } = require("electron");
module.exports = async function runAcceptance(window, data, mode = "standard") {
  const evidence = path.join(data, "Cache", "harmony-diagnostics");
  fs.mkdirSync(evidence, { recursive: true });
  const root = path.join(evidence, `acceptance-${randomUUID()}`);
  fs.mkdirSync(root);
  const report = {
    mode,
    startedAt: new Date().toISOString(),
    fileDialogs:
      mode === "native"
        ? "real native save picker"
        : "stubbed to isolated synthetic files; native picker is a separate check",
    stages: [],
    files: [],
  };
  const persist = () => {
    const content = JSON.stringify(report, null, 2);
    fs.writeFileSync(path.join(evidence, "harmony-acceptance.json"), content);
    fs.writeFileSync(path.join(root, "report.json"), content);
  };
  const transferRoot = path.join(path.dirname(data), "acceptance-transfers");
  fs.mkdirSync(transferRoot, { recursive: true });
  const backupPointer = path.join(transferRoot, "latest.json");
  let stage = "";
  const outputs = [];
  let imports = [];
  const original = {
    save: dialog.showSaveDialog,
    open: dialog.showOpenDialog,
    message: dialog.showMessageBox,
  };
  dialog.showSaveDialog = async (...args) => {
    if (stage === "cancel") return { canceled: true };
    if (mode === "native") return original.save(...args);
    const opts = args.at(-1),
      file = path.join(
        stage === "backup" ? transferRoot : root,
        `${randomUUID()}-${path.basename(opts.defaultPath || "output")}`,
      );
    outputs.push(file);
    return { canceled: false, filePath: file };
  };
  dialog.showOpenDialog = async (...args) => {
    if (args.at(-1).properties?.includes("openDirectory"))
      return { canceled: false, filePaths: [root] };
    const file =
      stage === "restore"
        ? JSON.parse(fs.readFileSync(backupPointer, "utf8")).path
        : imports.shift();
    if (!file) throw Error("Unexpected import picker");
    return { canceled: false, filePaths: [file] };
  };
  // The test fixture contains no complete patent claims; acknowledge its warning only.
  dialog.showMessageBox = async (...args) => ({
    response:
      args
        .at(-1)
        .buttons?.findIndex((b) => b.includes("仍然") || b.includes("继续") || b.includes("是")) >=
      0
        ? args
            .at(-1)
            .buttons.findIndex((b) => b.includes("仍然") || b.includes("继续") || b.includes("是"))
        : 0,
    checkboxChecked: false,
  });
  try {
    await window.webContents.executeJavaScript(
      `(async()=>{const a=window.patentApi.agreements;const r=await a.read();if(!r.ok)throw Error(JSON.stringify(r));if(r.value.needsConfirmation){const v=r.value;const x=await a.accept({appVersion:v.appVersion,termsVersion:v.policy.termsVersion,privacyVersion:v.policy.privacyVersion,participate:false});if(!x.ok)throw Error(JSON.stringify(x));}})()`,
    );
    const fixture = {
      dxf: fs.readFileSync(path.join(__dirname, "acceptance-fixture.dxf")).toString("base64"),
      png: fs.readFileSync(path.join(__dirname, "acceptance-fixture.png")).toString("base64"),
    };
    let stages = [
      "save",
      "cad",
      "image",
      "flowchart",
      "exports",
      "imports",
      "cancel",
      "search",
      "backup",
    ];
    if (mode === "restore") {
      const count = await window.webContents.executeJavaScript(
        "window.patentApi.patents.list('active').then(r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value.length})",
      );
      stages = count ? ["restoreVerify"] : ["restore"];
    }
    if (mode === "native") stages = ["native"];
    for (stage of stages) {
      const item = { stage, startedAt: new Date().toISOString() };
      report.stages.push(item);
      persist();
      if (stage === "imports")
        imports = [
          outputs.find((p) => p.endsWith(".patdoc")),
          outputs.find((p) => p.endsWith(".zip")),
        ].filter(Boolean);
      try {
        item.result = await window.webContents.executeJavaScript(
          `(${require("./acceptance-flow.cjs").toString()})(${JSON.stringify({ ...fixture, stage })})`,
        );
        item.status = "passed";
        if (stage === "native") {
          report.publicFiles = [
            item.result.path,
            item.result.patdoc.path,
            item.result.docx.outputPath,
            item.result.pdf.outputPath,
          ].map((file) => {
            const content = fs.readFileSync(file);
            const name = path.basename(file);
            // Preserve inspectable copies because hdc cannot read picker grants.
            fs.writeFileSync(path.join(root, name), content);
            return {
              path: file,
              bytes: content.length,
              sha256: createHash("sha256").update(content).digest("hex"),
            };
          });
        }
        if (stage === "backup")
          fs.writeFileSync(
            backupPointer,
            JSON.stringify({
              path: outputs.find((p) => p.endsWith(".zxwbackup")),
              source: require("./harmony-build.json").source,
            }),
          );
        if (stage === "restore") {
          persist();
          fs.writeFileSync(
            path.join(evidence, "restore-handoff.json"),
            JSON.stringify(item, null, 2),
          );
          item.commit = await window.webContents.executeJavaScript(
            `(${require("./acceptance-flow.cjs").toString()})(${JSON.stringify({ stage: "restoreCommit", operationId: item.result.preview.operationId })})`,
          );
        }
      } catch (error) {
        item.status = "failed";
        item.error = String(error.stack || error);
      }
      persist();
    }
    report.files = fs
      .readdirSync(root)
      .filter((name) => name !== "report.json")
      .map((name) => {
        const b = fs.readFileSync(path.join(root, name));
        return {
          name,
          bytes: b.length,
          signature: b.subarray(0, 8).toString("hex"),
          sha256: createHash("sha256").update(b).digest("hex"),
        };
      });
    report.window = { visible: window.isVisible(), focused: window.isFocused() };
    if (report.window.visible || report.window.focused)
      throw Error("Acceptance window became foreground");
    report.finishedAt = new Date().toISOString();
    persist();
    if (report.stages.some((item) => item.status !== "passed"))
      throw Error("Harmony acceptance failed; see the per-run report");
    return report;
  } finally {
    dialog.showSaveDialog = original.save;
    dialog.showOpenDialog = original.open;
    dialog.showMessageBox = original.message;
    persist();
  }
};

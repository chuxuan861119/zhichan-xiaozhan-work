import { readFile, writeFile } from "node:fs/promises";

// Generate a test-only copy beside the production bundle so relative resources stay correct.
const source = await readFile("out/main/index.js", "utf8");
const prefix = `
if (process.env.PATENT_WORKBENCH_TEST !== "1") throw new Error("Test-only entry");
dialog.showMessageBox = async () => ({response: 0, checkboxChecked: false});
dialog.showErrorBox = (_title, message) => { process.stderr.write("STARTUP_ERROR: " + message + "\\n"); };
app.relaunch = () => {};
`;
await writeFile("out/main/index.relocation-test.mjs", prefix + source);

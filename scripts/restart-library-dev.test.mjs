import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

test("real hidden Electron reloads from a new developer server after restart", {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "library-real-dev-"));
  await symlink(resolve("node_modules"), join(root, "node_modules"), "junction");
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "renderer"));
  await copyFile("scripts/restart-library-dev.mjs", join(root, "scripts/restart-library-dev.mjs"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "restart-audit",
      version: "1.0.0",
      main: "main.cjs",
      devDependencies: { electron: "*" },
    }),
  );
  await writeFile(
    join(root, "electron.vite.config.mjs"),
    `export default {renderer:{root:${JSON.stringify(join(root, "renderer"))},build:{rollupOptions:{input:${JSON.stringify(join(root, "renderer/index.html"))}}},server:{host:'127.0.0.1',port:0}}};`,
  );
  await writeFile(join(root, "renderer/index.html"), "<body>restart-renderer-ready</body>");
  await build({
    entryPoints: ["src/main/library/library-restart.ts"],
    outfile: join(root, "restart.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await writeFile(
    join(root, "main.cjs"),
    `
const {app,BrowserWindow}=require('electron');const fs=require('fs');const path=require('path');
const {restartAfterLibraryMove}=require('./restart.cjs');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
 await w.loadURL(process.env.ELECTRON_RENDERER_URL);
 const text=await w.webContents.executeJavaScript('document.body.textContent');
 if(process.argv.includes('--restarted')){
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({text,visible:w.isVisible(),pid:process.pid,parentPid:process.ppid,url:process.env.ELECTRON_RENDERER_URL}));
 }else{
  fs.writeFileSync(path.join(__dirname,'first.json'),JSON.stringify({pid:process.pid,url:process.env.ELECTRON_RENDERER_URL}));
  await restartAfterLibraryMove({isPackaged:false,rendererUrl:process.env.ELECTRON_RENDERER_URL,appPath:__dirname,execPath:process.execPath,args:[__dirname,'--restarted','--user-data-dir='+path.join(__dirname,'profile')],pid:process.pid,parentPid:process.ppid,logPath:path.join(__dirname,'restart.log')},{relaunch:()=>{throw Error('unexpected native relaunch')}});
 }
 app.quit();
}).catch(e=>{fs.writeFileSync(path.join(__dirname,'error.txt'),String(e));app.exit(1)});
`,
  );
  const environment = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_CLI_ARGS",
    "ELECTRON_ENTRY",
    "REMOTE_DEBUGGING_PORT",
  ])
    delete environment[key];
  const original = spawn(
    process.execPath,
    [
      resolve("node_modules/electron-vite/bin/electron-vite.js"),
      "dev",
      root,
      "--",
      `--user-data-dir=${join(root, "profile")}`,
    ],
    { cwd: root, env: environment, stdio: "ignore", windowsHide: true },
  );
  const originalExit = once(original, "exit");
  let result;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
      break;
    } catch {}
    await delay(100);
  }
  assert.ok(
    result,
    `No restarted window. ${await readFile(join(root, "error.txt"), "utf8").catch(() => "")} ${await readFile(join(root, "restart.log"), "utf8").catch(() => "")} (test profile retained: ${root})`,
  );
  await originalExit;
  assert.equal(result.text, "restart-renderer-ready");
  assert.equal(result.visible, false);
  const first = JSON.parse(await readFile(join(root, "first.json"), "utf8"));
  assert.notEqual(result.pid, first.pid);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while ((alive(result.pid) || alive(result.parentPid)) && Date.now() < deadline) await delay(100);
  assert.equal(alive(result.pid) || alive(result.parentPid), false);
  await unlink(join(root, "node_modules"));
  await rm(root, { recursive: true, force: true });
});

test("developer helper waits for exit, retains profile arguments, and clears node-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "library-dev-restart-"));
  const cli = join(root, "node_modules/electron-vite/bin");
  await mkdir(cli, { recursive: true });
  await writeFile(
    join(cli, "electron-vite.js"),
    `require('fs').writeFileSync('evidence.json', JSON.stringify({args:process.argv, nodeMode:process.env.ELECTRON_RUN_AS_NODE ?? null, url:process.env.ELECTRON_RENDERER_URL ?? null, library:process.env.PATENT_WORKBENCH_LIBRARY_ROOT}));`,
  );
  const original = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),1200)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const helper = spawn(
    process.execPath,
    [
      resolve("scripts/restart-library-dev.mjs"),
      String(original.pid),
      String(original.pid),
      root,
      join(root, "restart.log"),
      "--user-data-dir=D:/isolated",
      "--instance-tag=test",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_RENDERER_URL: "http://localhost:9999",
        PATENT_WORKBENCH_LIBRARY_ROOT: "D:/isolated-library",
      },
    },
  );
  let errors = "";
  helper.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const done = once(helper, "exit");
  try {
    assert.deepEqual(await once(helper, "message"), ["ready", undefined]);
    helper.send("restart");
    helper.disconnect();
    await delay(100);
    await assert.rejects(readFile(join(root, "evidence.json")), { code: "ENOENT" });
    const [code] = await done;
    assert.equal(code, 0, errors);
    const evidence = JSON.parse(await readFile(join(root, "evidence.json"), "utf8"));
    assert.equal(evidence.nodeMode, null);
    assert.equal(evidence.url, null);
    assert.equal(evidence.library, "D:/isolated-library");
    assert.ok(evidence.args.includes("--user-data-dir=D:/isolated"));
    assert.ok(evidence.args.includes("--instance-tag=test"));
  } finally {
    await done;
    await rm(root, { recursive: true, force: true });
  }
});

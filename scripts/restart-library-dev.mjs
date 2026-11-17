import { access, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [oldPid, serverPid, root, logPath, ...args] = process.argv.slice(2);
try {
  if (!process.send || !root || !logPath || !Number(oldPid) || !Number(serverPid))
    throw new Error("Invalid developer restart arguments");
  const cli = join(root, "node_modules/electron-vite/bin/electron-vite.js");
  await access(cli);
  await mkdir(dirname(logPath), { recursive: true });
  let approved = false;
  process.once("message", (message) => {
    approved = message === "restart";
  });
  const disconnected = new Promise((resolve) => process.once("disconnect", resolve));
  await new Promise((resolve, reject) =>
    process.send("ready", (error) => (error ? reject(error) : resolve())),
  );
  await disconnected;
  if (!approved) throw new Error("Developer restart cancelled");
  const alive = (pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const deadline = Date.now() + 60_000;
  while (alive(oldPid) || alive(serverPid)) {
    if (Date.now() > deadline) throw new Error("Old developer instance did not exit");
    await delay(100);
  }
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RENDERER_URL;
  delete process.env.ELECTRON_CLI_ARGS;
  delete process.env.ELECTRON_ENTRY;
  process.chdir(root);
  process.argv = [process.execPath, cli, "dev", root, "--", ...args];
  await appendFile(logPath, `${new Date().toISOString()} restarting developer instance\n`);
  await import(pathToFileURL(cli).href);
} catch (error) {
  if (logPath)
    await appendFile(logPath, `${new Date().toISOString()} ${String(error)}\n`).catch(() => {});
  process.exitCode = 1;
}

import { runCli } from "./client.js";

void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

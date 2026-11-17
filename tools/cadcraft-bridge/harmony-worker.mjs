import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

try {
  const { root, operation, bytes, fontPath, args } = workerData;
  const [javascript, wasm, font] = await Promise.all([
    readFile(join(root, "harmony/cadcraft-codec.js"), "utf8"),
    readFile(join(root, "harmony/cadcraft-codec_bg.wasm")),
    readFile(fontPath),
  ]);
  // The generated web module contains no external imports. Loading its exact
  // local bytes avoids package-type and file-URL differences across runtimes.
  const codec = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
  codec.initSync({ module: wasm });
  const output = codec.convert_cad(operation, bytes, JSON.stringify(args), font);
  parentPort.postMessage({ bytes: output }, [output.buffer]);
} catch (error) {
  const message = String(error);
  const code = ["ENOENT", "EACCES"].includes(error?.code)
    ? "CAD_RUNTIME_UNAVAILABLE"
    : /^Output exceeds 100 MiB\s*$/u.test(message) ||
        /^DWG: converting this [^\r\n]* produced more than [^\r\n]* drawing data \(the limit\)/u.test(
          message,
        )
      ? "CAD_OUTPUT_TOO_LARGE"
      : "CAD_CONVERSION_FAILED";
  parentPort.postMessage({ code });
}

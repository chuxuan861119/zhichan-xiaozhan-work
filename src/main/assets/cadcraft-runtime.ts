import { execFile } from "node:child_process";
import { join } from "node:path";
import cadFontPath from "../../shared/document/fonts/SourceHanSerifCN-Regular.otf?asset";
import { MAX_DRAWING_INPUT_BYTES } from "../../shared/drawing-markup/model.js";
import { isHarmonyPlatform } from "../../shared/platform.js";
import { AppOperationError } from "../app-operation-error.js";
import { runHarmonyCadCodec } from "./cadcraft-harmony-runtime.js";

export type CadCodecOperation = "dwg-to-dxf" | "dxf-to-dwg" | "dxf-to-svg" | "dxf-to-scene";

/** Isolated parser: no shell, no user-provided paths, bounded input/output and runtime. */
export async function runCadCodec(
  root: string,
  operation: CadCodecOperation,
  bytes: Uint8Array,
  options: { signal?: AbortSignal; args?: string[]; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  if (!bytes.byteLength || bytes.byteLength > MAX_DRAWING_INPUT_BYTES)
    throw new AppOperationError({ code: "INVALID_INPUT", message: "Invalid CAD input" });
  if (options.signal?.aborted)
    throw new AppOperationError({ code: "CANCELLED", message: "CAD cancelled" });
  if (isHarmonyPlatform(process.platform))
    return runHarmonyCadCodec(root, operation, bytes, cadFontPath, options);
  const binary = join(root, process.platform === "win32" ? "cadcraft-codec.exe" : "cadcraft-codec");
  return new Promise((resolve, reject) => {
    let inputError: Error | undefined;
    const fontPath = cadFontPath.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
    const child = execFile(
      binary,
      [operation, "--font", fontPath, ...(options.args ?? [])],
      {
        windowsHide: true,
        shell: false,
        encoding: "buffer",
        maxBuffer: MAX_DRAWING_INPUT_BYTES,
        timeout: options.timeoutMs ?? 120_000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (options.signal?.aborted)
          return reject(new AppOperationError({ code: "CANCELLED", message: "CAD cancelled" }));
        // Only recognize bounded, known codec diagnostics; never expose native output.
        const diagnostic = stderr.toString("utf8");
        if (
          error &&
          (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
            /^Output exceeds 100 MiB\s*$/u.test(diagnostic) ||
            /^DWG: converting this [^\r\n]* produced more than [^\r\n]* drawing data \(the limit\)/u.test(
              diagnostic,
            ))
        )
          return reject(
            new AppOperationError({ code: "CAD_OUTPUT_TOO_LARGE", message: "CAD output limit" }),
          );
        if (error || inputError)
          return reject(
            new AppOperationError({
              code:
                error && ["ENOENT", "EACCES", "ENOEXEC"].includes(String(error.code))
                  ? "CAD_RUNTIME_UNAVAILABLE"
                  : error?.killed
                    ? "CAD_CONVERSION_TIMEOUT"
                    : "CAD_CONVERSION_FAILED",
              message: "CAD codec failed",
            }),
          );
        if (!stdout.length)
          return reject(
            new AppOperationError({ code: "CAD_CONVERSION_FAILED", message: "Empty CAD output" }),
          );
        resolve(Uint8Array.from(stdout));
      },
    );
    child.stdin?.on("error", (error) => {
      inputError = error;
    });
    child.stdin?.end(bytes);
  });
}

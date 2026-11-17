import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

export async function loadDrawioRuntimeFiles(
  files: string[],
  initialGlobal: Record<string, unknown> = {},
) {
  const runtimeGlobal = { ...initialGlobal };
  const sandbox = { globalThis: runtimeGlobal, console };
  for (const file of files) {
    const source = await readFile(
      join(process.cwd(), "resources", "drawio", "runtime", file),
      "utf8",
    );
    vm.runInNewContext(source, sandbox, { filename: file });
  }
  return runtimeGlobal;
}

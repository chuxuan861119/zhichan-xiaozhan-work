import { createWriteStream } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const directory = dirname(fileURLToPath(import.meta.url));

async function zip(path, entries) {
  await new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    const output = createWriteStream(path);
    output.on("close", resolve);
    output.on("error", reject);
    archive.outputStream.on("error", reject);
    archive.outputStream.pipe(output);
    for (const [name, value] of entries) {
      archive.addBuffer(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), name);
    }
    archive.end();
  });
}

await mkdir(directory, { recursive: true });
const completePath = join(directory, ".fixture-source.patdoc.tmp");
const entries = [
  ["manifest.json", { formatVersion: 1, documentId: "fixture", assets: [] }],
  ["model.json", {}],
  ["settings.json", {}],
  ["editor-state.json", {}],
];
await zip(completePath, entries);
const complete = await readFile(completePath);
await writeFile(
  join(directory, "corrupt-truncated.patdoc"),
  complete.subarray(0, complete.length >> 1),
);
await zip(join(directory, "future-version.patdoc"), [
  ["manifest.json", { formatVersion: 3, patentId: "fixture", assets: [] }],
  ...entries.slice(1),
]);
await unlink(completePath);

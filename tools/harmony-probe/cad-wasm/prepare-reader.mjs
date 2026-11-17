import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const revision = "ACadSharp-d7dc111023477d8a9fffc2153139459c95b4f345";
const files = ["Tables/Collections/Table.cs", "Objects/CadDictionary.cs"];

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned reader event patch mismatch");
  return source.replace(before, after);
}

export function patchRemovalEvents(source, dictionary) {
  if (!dictionary && /override\s+CadObject\s+Clone\s*\(/.test(source))
    throw new Error("Pinned table clone patch mismatch");
  const declaration = "public event EventHandler<CollectionChangedEventArgs> OnRemove;";
  source = replaceOnce(
    source,
    declaration,
    `private HarmonyImportRemovalHandlers importRemovalHandlers = new();
    public event EventHandler<CollectionChangedEventArgs> OnRemove
    {
        add { importRemovalHandlers.Add(value); }
        remove { importRemovalHandlers.Remove(value); }
    }${
      dictionary
        ? ""
        : `
    public override CadObject Clone()
    {
        var clone = (Table<T>)base.Clone();
        clone.importRemovalHandlers = importRemovalHandlers.Clone();
        return clone;
    }`
    }`,
  );
  source = replaceOnce(
    source,
    "OnRemove?.Invoke(this, new CollectionChangedEventArgs(item));",
    "importRemovalHandlers.Invoke(this, new CollectionChangedEventArgs(item));",
  );
  if (dictionary)
    source = replaceOnce(
      source,
      "clone.OnRemove = null;",
      "clone.importRemovalHandlers = new HarmonyImportRemovalHandlers();",
    );
  return source;
}

export async function prepareReader(vendor, output) {
  const patched = await Promise.all(
    files.map(async (file) =>
      patchRemovalEvents(
        await readFile(join(vendor, revision, "src/ACadSharp", file), "utf8"),
        file.startsWith("Objects/"),
      ),
    ),
  );
  // Validate every anchor before writing; never modify the pinned vendor/native reader.
  await mkdir(output);
  await copyFile(
    join(here, "reader/CadImportReader.csproj"),
    join(output, "CadImportReader.csproj"),
  );
  for (let i = 0; i < files.length; i++) {
    const target = join(output, "patched", files[i]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, patched[i]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [vendor, output] = process.argv.slice(2);
  if (!output)
    throw new Error("Usage: prepare-reader.mjs <verified-pinned-vendor> <new-build-directory>");
  await prepareReader(resolve(vendor), resolve(output));
}

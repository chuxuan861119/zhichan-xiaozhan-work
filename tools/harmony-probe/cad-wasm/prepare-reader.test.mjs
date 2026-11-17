import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { patchRemovalEvents } from "./prepare-reader.mjs";

const table = `public event EventHandler<CollectionChangedEventArgs> OnRemove;
OnRemove?.Invoke(this, new CollectionChangedEventArgs(item));`;
test("patches subscriptions and invocation, and resets cloned dictionaries", () => {
  const result = patchRemovalEvents(`${table}\nclone.OnRemove = null;`, true);
  assert.match(result, /add \{ importRemovalHandlers.Add\(value\); \}/);
  assert.match(result, /remove \{ importRemovalHandlers.Remove\(value\); \}/);
  assert.match(result, /importRemovalHandlers.Invoke/);
  assert.match(result, /clone.importRemovalHandlers = new HarmonyImportRemovalHandlers/);
});
test("refuses changed, duplicate, or already patched source anchors", () => {
  assert.throws(() => patchRemovalEvents(table.replace("OnRemove;", "OnDeleted;"), false));
  assert.throws(() => patchRemovalEvents(table + table, false));
  assert.throws(() => patchRemovalEvents(patchRemovalEvents(table, false), false));
  assert.throws(() => patchRemovalEvents(`${table}\npublic override CadObject Clone()`, false));
});
test("table clones retain an independent copy of existing event subscriptions", () => {
  assert.match(
    patchRemovalEvents(table, false),
    /clone.importRemovalHandlers = importRemovalHandlers.Clone/,
  );
});
test("reader variant excludes originals and leaves the native project independent", async () => {
  const variant = await readFile(
    new URL("./reader/CadImportReader.csproj", import.meta.url),
    "utf8",
  );
  const native = await readFile(
    new URL("../../drawing-converter/reader-source/ACadSharp.Local.csproj", import.meta.url),
    "utf8",
  );
  assert.match(
    variant,
    /Exclude="[^"]*Tables\/Collections\/Table.cs;[^"]*Objects\/CadDictionary.cs"/,
  );
  assert.match(variant, /ImportRemovalHandlers.cs/);
  assert.doesNotMatch(native, /ImportRemovalHandlers|CadImportReader/);
});

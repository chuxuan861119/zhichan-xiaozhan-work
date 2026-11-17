import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adaptWorkbenchStartup } from "./workbench-startup-adapter.mjs";

test("adapts the actual startup chain without intercepting library recovery", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  const adapted = adaptWorkbenchStartup(source);
  assert.equal(adapted.split("globalThis.__harmonyStartupError(error);").length, 2);
  assert.ok(adapted.includes("await globalThis.__harmonyAdaptersReady;"));
  assert.ok(
    adapted.includes("}).catch((error: unknown) => {\n    if (tutorialSession) throw error;"),
  );
  assert.match(
    adapted,
    /globalThis\.__harmonyStartupError\(error\);\s+return reportStartupFailure/u,
  );
});

test("rejects missing or ambiguous startup failure handlers", () => {
  const init = 'await logger.log("info", { event: "app.started" });';
  const handler = ".catch((error: unknown) => {\n      return reportStartupFailure(";
  assert.throws(() => adaptWorkbenchStartup(init), /adapter anchor/u);
  assert.throws(() => adaptWorkbenchStartup(`${init}\n${handler}\n${handler}`), /adapter anchor/u);
});

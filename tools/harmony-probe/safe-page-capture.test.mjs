import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const capture = createRequire(import.meta.url)("./safe-page-capture.cjs");

test("captures hidden pages without requesting a wake lock, preserving the requested rectangle", async () => {
  const rectangle = { x: 20, y: 40, width: 600, height: 400 };
  const image = { isEmpty: () => false };
  const calls = [];
  const window = {
    capturePage: async (...args) => {
      calls.push(args);
      return image;
    },
  };
  assert.equal(await capture(window, rectangle), image);
  assert.deepEqual(calls, [[rectangle, { stayHidden: true, stayAwake: false }]]);
});

test("reports empty or failed capture rather than returning false evidence or retrying CDP", async () => {
  await assert.rejects(
    capture({ capturePage: async () => ({ isEmpty: () => true }) }),
    /empty image/,
  );
  const failure = new Error("Native capture failed");
  await assert.rejects(
    capture({
      capturePage: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
});

// @vitest-environment node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DrawingImportProgress,
  DrawingTimingHistory,
  ProgressLineDecoder,
} from "./drawing-import-progress.js";

test("only measured counters advance a running phase, timers cannot finish an import", () => {
  let now = 0;
  const events: any[] = [];
  const progress = new DrawingImportProgress(
    74 * 1024 * 1024,
    (event) => events.push(event),
    new DrawingTimingHistory(),
    () => now,
  );
  progress.update({ phase: "draw", completed: 10, total: 100 });
  const first = events.at(-1);
  now = 5000;
  progress.tick();
  expect(events.at(-1).overallPercent).toBe(first.overallPercent);
  expect(events.at(-1).elapsedMs).toBe(5000);
  progress.update({ phase: "draw", completed: 50, total: 100 });
  expect(events.at(-1).overallPercent).toBeGreaterThan(first.overallPercent);
  expect(events.at(-1).estimatedRemainingMs).not.toBeNull();
  progress.update({ phase: "store", completed: 1, total: 1 });
  expect(events.at(-1).overallPercent).toBeLessThan(100);
  progress.stop();
  const count = events.length;
  now = 10000;
  progress.tick();
  progress.update({ phase: "draw", completed: 1, total: 10 });
  expect(events).toHaveLength(count);
});

test("fragmented diagnostic streams accept only bounded progress and ignore private diagnostics", () => {
  const events: any[] = [];
  const decoder = new ProgressLineDecoder((event) => events.push(event));
  decoder.push('private drawing diagnostic\nZXW_CAD_PROGRESS {"phase":"draw","completed":2,');
  decoder.push('"total":4}\nZXW_CAD_PROGRESS {"phase":"draw","completed":9,"total":4}\n');
  decoder.push('ZXW_CAD_PROGRESS {"phase":"draw","completed":1,"total":2,"path":"private"}\n');
  decoder.push("x".repeat(20000));
  decoder.push('\nZXW_CAD_PROGRESS {"phase":"parse","completed":null,"total":null}\n');
  expect(events).toEqual([
    { phase: "draw", completed: 2, total: 4 },
    { phase: "parse", completed: null, total: null },
  ]);
});

test("only advancing phase or counters reset the idle observation, and sleep does not count as idle", () => {
  let now = 0;
  const events: import("../../shared/drawing-markup/import-progress.js").DrawingImportProgressValue[] =
    [];
  const progress = new DrawingImportProgress(
    74 * 1024 * 1024,
    (e) => events.push(e),
    new DrawingTimingHistory(),
    () => now,
  );
  progress.update({ phase: "draw", completed: 10, total: 100 });
  for (let i = 0; i < 180; i++) {
    now += 1000;
    progress.tick();
    progress.update({ phase: "draw", completed: 10, total: 100 });
  }
  expect(events.at(-1)?.waitingForActivity).toBe(true);
  progress.update({ phase: "draw", completed: 11, total: 100 });
  expect(events.at(-1)?.waitingForActivity).toBe(false);
  now += 24 * 60 * 60 * 1000;
  progress.tick();
  expect(events.at(-1)?.waitingForActivity).toBe(false);
  progress.update({ phase: "svg", completed: null, total: null });
  expect(events.at(-1)?.waitingForActivity).toBe(false);
});

test("local timing calibration persists bounded aggregates without source names or content", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "cad-timing-test-")), "timing.json");
  const history = new DrawingTimingHistory(path);
  await history.ready;
  history.record("draw", 10 * 1024 * 1024, 20000);
  await history.save();
  const restored = new DrawingTimingHistory(path);
  await restored.ready;
  expect(restored.expected("draw", 20 * 1024 * 1024)).toBeCloseTo(40000);
  const text = await readFile(path, "utf8");
  expect(Object.keys(JSON.parse(text))).toEqual(["version", "stages"]);
  expect(text).not.toMatch(/originalName|source|content|sessionId|operationId/);
});

import { expect, it } from "vitest";
import { DrawingImportJobs } from "./drawing-import-jobs.js";

it("cancels only a matching owner, session and active operation", () => {
  const jobs = new DrawingImportJobs();
  const first = jobs.start(1, "session-a", "operation");
  expect(jobs.cancel(2, "session-a", "operation")).toBe(false);
  expect(jobs.cancel(1, "session-b", "operation")).toBe(false);
  expect(first.signal.aborted).toBe(false);
  expect(() => jobs.start(1, "session-a", "operation")).toThrow();
  expect(jobs.cancel(1, "session-a", "operation")).toBe(true);
  expect(first.signal.aborted).toBe(true);
  jobs.finish(1, "operation");
  expect(jobs.cancel(1, "session-a", "operation")).toBe(false);
});

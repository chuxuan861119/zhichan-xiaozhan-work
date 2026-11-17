import { expect, test } from "vitest";
import { ColumnWheelMotion } from "./dual-column-wheel";

test("wheel input advances through intermediate positions and settles exactly", () => {
  const motion = new ColumnWheelMotion();
  motion.add(0, 120, 1000, 0);
  expect(motion.sample(0)).toBe(0);
  expect(motion.sample(16)).toBeGreaterThan(0);
  expect(motion.sample(16)).toBeLessThan(120);
  expect(motion.sample(180)).toBe(120);
  expect(motion.running).toBe(false);
});

test("continuous input accumulates distance without starting a second animation", () => {
  const motion = new ColumnWheelMotion();
  motion.add(0, 120, 1000, 0);
  const current = motion.sample(32);
  motion.add(current, 120, 1000, 32);
  expect(motion.sample(32)).toBe(current);
  expect(motion.sample(48)).toBeGreaterThan(current);
  expect(motion.sample(212)).toBe(240);
});

test("opposite input discards the old pending distance and responds immediately", () => {
  const motion = new ColumnWheelMotion();
  motion.add(300, 240, 1000, 0);
  const current = motion.sample(32);
  motion.add(current, -120, 1000, 32);
  expect(motion.sample(48)).toBeLessThan(current);
  expect(motion.sample(212)).toBe(current - 120);
});

test("clamps the target so overscroll never accumulates at either boundary", () => {
  const motion = new ColumnWheelMotion();
  motion.add(900, 5000, 1000, 0);
  expect(motion.sample(180)).toBe(1000);
  motion.add(1000, -40, 1000, 180);
  expect(motion.sample(360)).toBe(960);
  motion.add(960, -5000, 1000, 360);
  expect(motion.sample(540)).toBe(0);
  motion.add(0, 40, 1000, 540);
  expect(motion.sample(720)).toBe(40);
});

test("cancellation discards pending distance before the next input", () => {
  const motion = new ColumnWheelMotion();
  motion.add(0, 120, 1000, 0);
  motion.cancel();
  expect(motion.running).toBe(false);
  motion.add(500, 40, 1000, 100);
  expect(motion.sample(280)).toBe(540);
});

test("precise pixel input follows the next frame without a second easing tail", () => {
  const motion = new ColumnWheelMotion();
  motion.add(0, 8, 1000, 0, 0);
  motion.add(0, 8, 1000, 4, 0);
  expect(motion.sample(16)).toBe(16);
  expect(motion.running).toBe(false);
});

test("a fast pixel stream remains direct even when momentum produces larger deltas", async () => {
  const { columnWheelDuration } = await import("./dual-column-wheel");
  expect(columnWheelDuration(0, 8, Infinity)).toBe(0);
  expect(columnWheelDuration(0, 90, 16)).toBe(0);
  expect(columnWheelDuration(0, 120, 100)).toBe(180);
  expect(columnWheelDuration(1, 3, 16)).toBe(180);
});

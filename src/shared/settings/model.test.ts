import { expect, test, vi } from "vitest";
import { SNAPSHOT_INTERVAL_OPTIONS, SnapshotSettingsSchema } from "../snapshot/model.js";
import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  createSettingsId,
  DEFAULT_APP_SETTINGS,
} from "./model.js";

test("legacy settings get new preference defaults without resetting unrelated patches", () => {
  const legacy = { ...DEFAULT_APP_SETTINGS } as Record<string, unknown>;
  delete legacy.drawingAnnotationDefaults;
  delete legacy.drawingAutoAdjustLabelSize;
  delete legacy.aiConnectionsEnabled;
  delete legacy.uiScalePercent;
  delete legacy.reducedMotion;
  delete legacy.dualColumnFlow;
  delete legacy.inventionContentPrefix;
  delete legacy.closeToTray;
  delete legacy.trayIntroDismissed;
  expect(AppSettingsSchema.parse(legacy)).toEqual(DEFAULT_APP_SETTINGS);
  expect(AppSettingsPatchSchema.parse({ zoomPercent: 110 })).toEqual({ zoomPercent: 110 });
  expect(AppSettingsPatchSchema.parse({ aiConnectionsEnabled: false })).toEqual({
    aiConnectionsEnabled: false,
  });
});

test("dual column flow defaults to D4 and E1 without cable and validates all styles and modes", () => {
  expect(DEFAULT_APP_SETTINGS.dualColumnFlow).toEqual({
    style: "graphite",
    mode: "boxes",
    margin: "dust",
  });
  for (const style of ["classic", "slim", "ceramic", "graphite"]) {
    for (const mode of ["cable", "boxes", "off"]) {
      const patch = { dualColumnFlow: { style, mode } };
      expect(AppSettingsPatchSchema.parse(patch)).toEqual({
        dualColumnFlow: { style, mode, margin: "dust" },
      });
    }
  }
  expect(
    AppSettingsPatchSchema.safeParse({ dualColumnFlow: { style: "other", mode: "cable" } }).success,
  ).toBe(false);
});

test("validates a single-line invention prefix", () => {
  expect(AppSettingsPatchSchema.parse({ inventionContentPrefix: "优选地，" })).toEqual({
    inventionContentPrefix: "优选地，",
  });
  for (const value of ["", "  ", "进一步\n地", "字".repeat(61)]) {
    expect(AppSettingsPatchSchema.safeParse({ inventionContentPrefix: value }).success).toBe(false);
  }
});

test("creates a cryptographically random UUID when Web Crypto lacks randomUUID", () => {
  const crypto = { getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(0xab)) };

  expect(createSettingsId(crypto)).toBe("abababab-abab-4bab-abab-abababababab");
  expect(crypto.getRandomValues).toHaveBeenCalledOnce();
});

test("accepts only the supported automatic snapshot intervals", () => {
  expect(SnapshotSettingsSchema.parse({ enabled: true, intervalMinutes: 5 })).toEqual({
    enabled: true,
    intervalMinutes: 5,
  });
  expect(SnapshotSettingsSchema.safeParse({ enabled: true, intervalMinutes: 1 }).success).toBe(
    false,
  );
  expect(
    SnapshotSettingsSchema.safeParse({ enabled: true, intervalMinutes: 5, maxCount: 30 }).success,
  ).toBe(false);
  expect(SNAPSHOT_INTERVAL_OPTIONS.map(({ value }) => value)).toEqual([3, 5, 10, 15, 30, 60]);
});

test("defaults the patent library to a single-column view and accepts only supported modes", () => {
  expect(DEFAULT_APP_SETTINGS.patentLibraryViewMode).toBe("single");
  expect(AppSettingsSchema.parse(DEFAULT_APP_SETTINGS).patentLibraryViewMode).toBe("single");
  expect(AppSettingsPatchSchema.parse({ patentLibraryViewMode: "double" })).toEqual({
    patentLibraryViewMode: "double",
  });
  expect(AppSettingsPatchSchema.parse({ patentLibraryViewMode: "illustrated" })).toEqual({
    patentLibraryViewMode: "illustrated",
  });
  expect(AppSettingsPatchSchema.safeParse({ patentLibraryViewMode: "grid" }).success).toBe(false);
});

test("new installations start at 100 percent and legacy zoom values remain readable", () => {
  expect(DEFAULT_APP_SETTINGS.zoomPercent).toBe(100);
  expect(AppSettingsSchema.parse({ ...DEFAULT_APP_SETTINGS, zoomPercent: 125 }).zoomPercent).toBe(
    125,
  );
});

test("update detection defaults on for old settings, while unrelated patches do not re-enable it", () => {
  const old = { ...DEFAULT_APP_SETTINGS } as Record<string, unknown>;
  delete old.autoCheckUpdates;
  expect(AppSettingsSchema.parse(old).autoCheckUpdates).toBe(true);
  expect(AppSettingsPatchSchema.parse({})).toEqual({});
  expect(AppSettingsPatchSchema.parse({ autoCheckUpdates: false })).toEqual({
    autoCheckUpdates: false,
  });
  expect(AppSettingsPatchSchema.safeParse({ autoCheckUpdates: undefined }).success).toBe(false);
});

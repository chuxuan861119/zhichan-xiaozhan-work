import { describe, expect, test, vi } from "vitest";
import { randomUuid } from "./id.js";

describe("randomUuid", () => {
  test("uses crypto.randomUUID when available", () => {
    const original = globalThis.crypto.randomUUID;
    const mock = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: mock,
    });
    try {
      expect(randomUuid()).toBe("00000000-0000-4000-8000-000000000000");
      expect(mock).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: original,
      });
    }
  });

  test("falls back to getRandomValues and returns a version-4 UUID shape", () => {
    const originalUuid = globalThis.crypto.randomUUID;
    const originalGetRandomValues = globalThis.crypto.getRandomValues;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value: vi.fn((bytes: Uint8Array) => bytes.fill(0xab)),
    });
    try {
      const id = randomUuid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(globalThis.crypto.getRandomValues).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: originalUuid,
      });
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: originalGetRandomValues,
      });
    }
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { moveNoReplaceMac, movePathNoReplace } from "./move-no-replace.js";

test.runIf(process.platform === "darwin")(
  "atomic Mac moves preserve an existing target and choose one concurrent winner",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mac-atomic-move-"));
    const a = join(root, "中文 source\nA"),
      b = join(root, "source B"),
      target = join(root, "target");
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, "data"), "A");
    await writeFile(join(b, "data"), "B");
    const results = await Promise.allSettled([
      moveNoReplaceMac(a, target),
      moveNoReplaceMac(b, target),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "EEXIST" },
    });
    const winner = await readFile(join(target, "data"), "utf8");
    const remaining = winner === "A" ? b : a;
    await expect(moveNoReplaceMac(remaining, target)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(target, "data"), "utf8")).toBe(winner);
    const dest = join(root, "file");
    await writeFile(dest, "existing");
    await expect(moveNoReplaceMac(join(remaining, "data"), dest)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(dest, "utf8")).toBe("existing");
  },
);

test.skipIf(process.platform !== "win32")(
  "atomically moves export files and directories without replacing existing targets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "export-no-replace-"));
    try {
      const source = join(root, "source"),
        target = join(root, "target");
      await mkdir(source);
      await writeFile(join(source, "owner"), "synthetic owner");
      await movePathNoReplace(source, target);
      expect(await readFile(join(target, "owner"), "utf8")).toBe("synthetic owner");
      await mkdir(source);
      await writeFile(join(source, "owner"), "different owner");
      await expect(movePathNoReplace(source, target)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(target, "owner"), "utf8")).toBe("synthetic owner");
      const file = join(root, "record"),
        final = join(root, "published-record");
      await writeFile(file, "first");
      await movePathNoReplace(file, final);
      await writeFile(file, "second");
      await expect(movePathNoReplace(file, final)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(final, "utf8")).toBe("first");
      expect(await readFile(file, "utf8")).toBe("second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

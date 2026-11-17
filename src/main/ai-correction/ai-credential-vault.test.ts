import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AiCredentialVault } from "./ai-credential-vault.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-correction-vault-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/u, ""),
  };
}

describe("AI credential vault", () => {
  const firstProfileId = "a878463b-d7d4-4e59-8471-e04a03ef5367";
  const secondProfileId = "9c2bcfd4-8032-4e3e-8521-05ae647f85fa";

  test("listing saved keys never unlocks system storage and actual uses share one unlock", async () => {
    const root = await createRoot();
    await new AiCredentialVault(root, safeStorage()).setApiKey(firstProfileId, "test-key");
    const storage = safeStorage();
    storage.decryptString = vi.fn(storage.decryptString);
    storage.isEncryptionAvailable = vi.fn(storage.isEncryptionAvailable);
    const vault = new AiCredentialVault(root, storage);
    expect(await vault.listProfileIds()).toEqual([firstProfileId]);
    expect(storage.decryptString).not.toHaveBeenCalled();
    expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
    const results = await Promise.all(
      [1, 2, 3].map(() => vault.withApiKey(firstProfileId, async (key) => key)),
    );
    expect(results).toEqual(["test-key", "test-key", "test-key"]);
    expect(storage.decryptString).toHaveBeenCalledTimes(1);
  });
  test("legacy keys stay opaque in settings and get a non-secret index after actual use", async () => {
    const root = await createRoot();
    const storage = safeStorage();
    const ciphertextBase64 = storage
      .encryptString(JSON.stringify({ [firstProfileId]: "legacy-test" }))
      .toString("base64");
    await writeFile(
      join(root, "ai-credentials.json"),
      JSON.stringify({ version: 2, ciphertextBase64 }),
    );
    storage.decryptString = vi.fn(storage.decryptString);
    const vault = new AiCredentialVault(root, storage);
    expect(await vault.listProfileIds()).toEqual([]);
    expect(await vault.hasUnindexedCredentials()).toBe(true);
    expect(storage.decryptString).not.toHaveBeenCalled();
    await expect(vault.withApiKey(firstProfileId, async (key) => key)).resolves.toBe("legacy-test");
    const stored = JSON.parse(await readFile(join(root, "ai-credentials.json"), "utf8"));
    expect(stored).toEqual({ version: 3, ciphertextBase64, profileIds: [firstProfileId] });
    const restarted = new AiCredentialVault(root, storage);
    expect(await restarted.listProfileIds()).toEqual([firstProfileId]);
    expect(await restarted.hasUnindexedCredentials()).toBe(false);
    expect(storage.decryptString).toHaveBeenCalledTimes(1);
  });

  test("file changes, replacing a key, deleting it and releasing the session never reuse stale keys", async () => {
    const root = await createRoot();
    const storage = safeStorage();
    storage.decryptString = vi.fn(storage.decryptString);
    const vault = new AiCredentialVault(root, storage);
    await vault.setApiKey(firstProfileId, "first-test");
    await vault.withApiKey(firstProfileId, async (key) => expect(key).toBe("first-test"));
    expect(storage.decryptString).not.toHaveBeenCalled();
    const other = new AiCredentialVault(root, safeStorage());
    await other.setApiKey(firstProfileId, "replacement-test");
    await vault.withApiKey(firstProfileId, async (key) => expect(key).toBe("replacement-test"));
    expect(storage.decryptString).toHaveBeenCalledTimes(1);
    vault.clearSessionCache();
    await vault.withApiKey(firstProfileId, async (key) => expect(key).toBe("replacement-test"));
    expect(storage.decryptString).toHaveBeenCalledTimes(2);
    await vault.clearApiKey(firstProfileId);
    await expect(vault.withApiKey(firstProfileId, async (key) => key)).rejects.toThrow();
  });

  test("failed unlocks remain retryable and never seed the session cache", async () => {
    const root = await createRoot();
    await new AiCredentialVault(root, safeStorage()).setApiKey(firstProfileId, "retry-test");
    const storage = safeStorage();
    const decrypt = storage.decryptString;
    storage.decryptString = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Error("cancelled");
      })
      .mockImplementation(decrypt);
    const vault = new AiCredentialVault(root, storage);
    await expect(vault.withApiKey(firstProfileId, async (key) => key)).rejects.toThrow();
    await expect(vault.withApiKey(firstProfileId, async (key) => key)).resolves.toBe("retry-test");
    await vault.withApiKey(firstProfileId, async (key) => key);
    expect(storage.decryptString).toHaveBeenCalledTimes(2);
  });

  test.each(["linux", "openharmony"])(
    "refuses an insecure basic_text storage backend on %s",
    async (platform) => {
      const root = await createRoot();
      const storage = { ...safeStorage(), getSelectedStorageBackend: () => "basic_text" };
      const vault = new AiCredentialVault(root, storage, undefined, platform);
      await expect(vault.setApiKey(firstProfileId, "never-persist-test")).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      expect(await vault.listProfileIds()).toEqual([]);
    },
  );

  test("stores separately encrypted profile keys without plaintext", async () => {
    const root = await createRoot();
    const vault = new AiCredentialVault(root, safeStorage());

    await vault.setApiKey(firstProfileId, "sk-secret");
    await vault.setApiKey(secondProfileId, "sk-other");

    expect(await vault.hasApiKey(firstProfileId)).toBe(true);
    expect(await vault.listProfileIds()).toEqual([firstProfileId, secondProfileId]);
    await expect(vault.withApiKey(firstProfileId, async (value) => value)).resolves.toBe(
      "sk-secret",
    );
    const stored = await readFile(join(root, "ai-credentials.json"), "utf8");
    expect(stored).not.toContain("sk-secret");
    expect(stored).not.toContain("sk-other");

    await vault.clearApiKey(firstProfileId);
    expect(await vault.hasApiKey(firstProfileId)).toBe(false);
    expect(await vault.hasApiKey(secondProfileId)).toBe(true);
  });

  test("treats malformed ciphertext as unavailable without falling back to plaintext", async () => {
    const root = await createRoot();
    const vault = new AiCredentialVault(root, safeStorage());
    await vault.setApiKey(firstProfileId, "sk-secret");
    await writeFile(join(root, "ai-credentials.json"), "not-json");

    await expect(vault.hasApiKey(firstProfileId)).resolves.toBe(false);
    await expect(vault.withApiKey(firstProfileId, async (value) => value)).rejects.toMatchObject({
      code: "AI_CREDENTIAL_UNAVAILABLE",
    });
  });
  test("concurrent model saves retain both credentials", async () => {
    const root = await createRoot();
    const vault = new AiCredentialVault(root, safeStorage());
    await Promise.all([
      vault.setApiKey(firstProfileId, "first"),
      vault.setApiKey(secondProfileId, "second"),
    ]);
    expect((await vault.listProfileIds()).sort()).toEqual([firstProfileId, secondProfileId].sort());
  });
  test("explicit recovery preserves the unreadable file and accepts a new key", async () => {
    const root = await createRoot();
    const path = join(root, "ai-credentials.json");
    await writeFile(path, "unreadable-envelope");
    const vault = new AiCredentialVault(root, safeStorage());
    await expect(vault.setApiKey(firstProfileId, "new-key")).rejects.toMatchObject({
      code: "AI_CREDENTIAL_UNAVAILABLE",
    });
    expect(await readFile(path, "utf8")).toBe("unreadable-envelope");
    await vault.setApiKey(firstProfileId, "new-key", { resetUnavailable: true });
    const backups = (await readdir(root)).filter((name) =>
      name.startsWith("ai-credentials.unavailable-"),
    );
    expect(backups).toHaveLength(1);
    const backup = backups[0];
    if (!backup) throw new Error("Recovery backup missing");
    expect(await readFile(join(root, backup), "utf8")).toBe("unreadable-envelope");
    await expect(vault.withApiKey(firstProfileId, async (key) => key)).resolves.toBe("new-key");
  });
  test("recovery never resets a readable vault or an unavailable encryption service", async () => {
    const root = await createRoot();
    const storage = safeStorage();
    const vault = new AiCredentialVault(root, storage);
    await vault.setApiKey(firstProfileId, "first");
    await vault.setApiKey(secondProfileId, "second", { resetUnavailable: true });
    expect(await vault.hasApiKey(firstProfileId)).toBe(true);
    const before = await readFile(join(root, "ai-credentials.json"));
    storage.isEncryptionAvailable = () => false;
    await expect(
      vault.setApiKey(firstProfileId, "replacement", { resetUnavailable: true }),
    ).rejects.toThrow();
    expect(await readFile(join(root, "ai-credentials.json"))).toEqual(before);
  });

  test("failed recovery write keeps the original vault intact", async () => {
    const root = await createRoot();
    const path = join(root, "ai-credentials.json");
    await writeFile(path, "unreadable-envelope");
    const vault = new AiCredentialVault(root, safeStorage(), async () => {
      throw new Error("disk unavailable");
    });
    await expect(
      vault.setApiKey(firstProfileId, "replacement", { resetUnavailable: true }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("unreadable-envelope");
  });
});

test("concurrent GUI and CLI credential writes preserve all profiles and recheck queued authority", async () => {
  const root = await createRoot();
  const vault = new AiCredentialVault(root, safeStorage());
  const first = "a878463b-d7d4-4e59-8471-e04a03ef5367";
  const second = "9c2bcfd4-8032-4e3e-8521-05ae647f85fa";
  await Promise.all([vault.setApiKey(first, "test-first"), vault.setApiKey(second, "test-second")]);
  expect(new Set(await vault.listProfileIds())).toEqual(new Set([first, second]));
  await expect(
    vault.clearApiKey(first, () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(await vault.hasApiKey(first)).toBe(true);
});

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { LEGACY_AI_PROFILE_ID } from "../../shared/ai-correction/model.js";
import { isHarmonyPlatform } from "../../shared/platform.js";

const CREDENTIAL_FILE_NAME = "ai-credentials.json";
const MAX_ENVELOPE_BYTES = 64 * 1024;

const CredentialEnvelopeSchema = z.discriminatedUnion("version", [
  z
    .object({ version: z.literal(1), ciphertextBase64: z.string().min(4).max(MAX_ENVELOPE_BYTES) })
    .strict(),
  z
    .object({ version: z.literal(2), ciphertextBase64: z.string().min(4).max(MAX_ENVELOPE_BYTES) })
    .strict(),
  z
    .object({
      version: z.literal(3),
      ciphertextBase64: z.string().min(4).max(MAX_ENVELOPE_BYTES),
      profileIds: z.array(z.uuid()).max(400),
    })
    .strict(),
]);
const CredentialMapSchema = z.record(z.uuid(), z.string().min(1).max(4_000));

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(ciphertext: Buffer): string;
  getSelectedStorageBackend?(): string;
};

export class AiCredentialError extends Error {
  readonly code = "AI_CREDENTIAL_UNAVAILABLE" as const;

  constructor() {
    super("AI 服务密钥不可用，请重新输入 API Key。");
    this.name = "AiCredentialError";
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AiCredentialVault {
  #mutation: Promise<void> = Promise.resolve();
  #unlocked: { identity: string; keys: Record<string, string> } | null = null;

  clearSessionCache(): void {
    this.#unlocked = null;
  }

  #requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) throw new AiCredentialError();
    if (
      (this.platform === "linux" || isHarmonyPlatform(this.platform)) &&
      this.safeStorage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new AiCredentialError();
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(action);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  constructor(
    private readonly userDataPath: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly writeAtomic: (
      filename: string,
      data: string,
      options?: writeFileAtomic.Options | BufferEncoding,
    ) => Promise<void> = writeFileAtomic,
    private readonly platform: string = process.platform,
  ) {}

  async hasApiKey(profileId: string): Promise<boolean> {
    try {
      return await this.#serialize(async () =>
        Boolean((await this.#readKeyMap({ indexLegacy: true }))[profileId]),
      );
    } catch {
      return false;
    }
  }

  async listProfileIds(): Promise<string[]> {
    try {
      const { envelope, identity } = await this.#readEnvelope();
      if (envelope.version === 3) return [...envelope.profileIds];
      if (envelope.version === 1) return [LEGACY_AI_PROFILE_ID];
      return this.#unlocked?.identity === identity ? Object.keys(this.#unlocked.keys) : [];
    } catch {
      return [];
    }
  }

  async hasUnindexedCredentials(): Promise<boolean> {
    try {
      const { envelope, identity } = await this.#readEnvelope();
      return envelope.version === 2 && this.#unlocked?.identity !== identity;
    } catch {
      return false;
    }
  }

  async setApiKey(
    profileId: string,
    apiKey: string,
    optionsOrBeforeWrite: { resetUnavailable?: boolean } | (() => void) = {},
  ): Promise<void> {
    const options = typeof optionsOrBeforeWrite === "function" ? {} : optionsOrBeforeWrite;
    const beforeWrite =
      typeof optionsOrBeforeWrite === "function" ? optionsOrBeforeWrite : undefined;
    const id = z.uuid().parse(profileId);
    const value = apiKey.trim();
    if (value.length === 0 || value.length > 4_000) throw new AiCredentialError();
    await this.#serialize(async () => {
      let keys: Record<string, string>;
      try {
        keys = await this.#readKeyMap({ allowMissing: true });
      } catch (error) {
        if (!options.resetUnavailable) throw error;
        this.#requireEncryption();
        // Explicit recovery preserves the original before any atomic replacement.
        const backup = join(this.userDataPath, `ai-credentials.unavailable-${randomUUID()}.json`);
        await copyFile(this.#path(), backup, constants.COPYFILE_EXCL);
        await chmod(backup, 0o600);
        keys = {};
      }
      beforeWrite?.();
      await this.#writeKeyMap({ ...keys, [id]: value });
    });
  }

  async clearApiKey(profileId: string, beforeWrite?: () => void): Promise<void> {
    const id = z.uuid().parse(profileId);
    await this.#serialize(async () => {
      const keys = await this.#readKeyMap({ allowMissing: true });
      beforeWrite?.();
      delete keys[id];
      if (Object.keys(keys).length === 0) {
        try {
          await unlink(this.#path());
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw new AiCredentialError();
        }
        this.clearSessionCache();
        return;
      }
      await this.#writeKeyMap(keys);
    });
  }

  async withApiKey<T>(profileId: string, use: (apiKey: string) => Promise<T>): Promise<T> {
    const key = await this.#serialize(
      async () => (await this.#readKeyMap({ indexLegacy: true }))[profileId],
    );
    if (!key) throw new AiCredentialError();
    return await use(key);
  }

  async #writeKeyMap(keys: Record<string, string>): Promise<void> {
    this.#requireEncryption();
    let ciphertext: Buffer | undefined;
    try {
      ciphertext = this.safeStorage.encryptString(JSON.stringify(CredentialMapSchema.parse(keys)));
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_ENVELOPE_BYTES) {
        throw new AiCredentialError();
      }
      const identity = `${JSON.stringify({ version: 3, ciphertextBase64: ciphertext.toString("base64"), profileIds: Object.keys(keys) })}\n`;
      if (Buffer.byteLength(identity) > MAX_ENVELOPE_BYTES) throw new AiCredentialError();
      await this.writeAtomic(this.#path(), identity, { encoding: "utf8", mode: 0o600 });
      this.#unlocked = { identity, keys: { ...keys } };
    } catch (error) {
      throw error instanceof AiCredentialError ? error : new AiCredentialError();
    } finally {
      ciphertext?.fill(0);
    }
  }

  async #readEnvelope() {
    const contents = await readFile(this.#path());
    if (contents.byteLength === 0 || contents.byteLength > MAX_ENVELOPE_BYTES)
      throw new AiCredentialError();
    const identity = contents.toString("utf8");
    const envelope = CredentialEnvelopeSchema.parse(JSON.parse(identity));
    const encrypted = Buffer.from(envelope.ciphertextBase64, "base64");
    try {
      if (!encrypted.byteLength || encrypted.toString("base64") !== envelope.ciphertextBase64)
        throw new AiCredentialError();
    } finally {
      encrypted.fill(0);
    }
    return { identity, envelope };
  }

  async #readKeyMap(
    options: { allowMissing?: boolean; indexLegacy?: boolean } = {},
  ): Promise<Record<string, string>> {
    let encrypted: Buffer | undefined;
    try {
      const { identity, envelope } = await this.#readEnvelope();
      if (this.#unlocked?.identity === identity) return { ...this.#unlocked.keys };
      this.clearSessionCache();
      this.#requireEncryption();
      encrypted = Buffer.from(envelope.ciphertextBase64, "base64");
      const plainText = this.safeStorage.decryptString(encrypted).trim();
      let keys: Record<string, string>;
      if (envelope.version === 1) {
        if (!plainText || plainText.length > 4_000) throw new AiCredentialError();
        keys = { [LEGACY_AI_PROFILE_ID]: plainText };
      } else {
        keys = CredentialMapSchema.parse(JSON.parse(plainText));
        if (
          envelope.version === 3 &&
          JSON.stringify([...envelope.profileIds].sort()) !==
            JSON.stringify(Object.keys(keys).sort())
        )
          throw new AiCredentialError();
      }
      let cacheIdentity = identity;
      if (options.indexLegacy && envelope.version === 2) {
        const indexed = `${JSON.stringify({ version: 3, ciphertextBase64: envelope.ciphertextBase64, profileIds: Object.keys(keys) })}\n`;
        try {
          await this.writeAtomic(this.#path(), indexed, { encoding: "utf8", mode: 0o600 });
          cacheIdentity = indexed;
        } catch {
          /* An index write failure must not prevent an already-authorized AI request. */
        }
      }
      this.#unlocked = { identity: cacheIdentity, keys: { ...keys } };
      return keys;
    } catch (error) {
      this.clearSessionCache();
      if (options.allowMissing && isNodeError(error, "ENOENT")) return {};
      throw error instanceof AiCredentialError ? error : new AiCredentialError();
    } finally {
      encrypted?.fill(0);
    }
  }

  #path(): string {
    return join(this.userDataPath, CREDENTIAL_FILE_NAME);
  }
}

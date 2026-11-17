import { TextDecoder } from "node:util";

export const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
export type PlaintextEnvelope = Uint8Array;

export class PlaintextCodecError extends Error {
  constructor() {
    super("本地数据格式无效。");
    this.name = "PlaintextCodecError";
  }
}

function fail(): never {
  throw new PlaintextCodecError();
}

function checkedBytes(value: unknown): Uint8Array {
  if (
    Object.prototype.toString.call(value) !== "[object Uint8Array]" ||
    (value as Uint8Array).byteLength > MAX_PLAINTEXT_BYTES
  ) {
    fail();
  }
  return value as Uint8Array;
}

export function encodeBytes(value: Uint8Array): PlaintextEnvelope {
  return Uint8Array.from(checkedBytes(value));
}

export function decodeBytes(value: PlaintextEnvelope): Uint8Array {
  return Uint8Array.from(checkedBytes(value));
}

export function encodeJson<T>(value: T): PlaintextEnvelope {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") fail();
    return encodeBytes(Buffer.from(json, "utf8"));
  } catch (error) {
    if (error instanceof PlaintextCodecError) throw error;
    fail();
  }
}

export function decodeJson<T>(value: PlaintextEnvelope): T {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(checkedBytes(value));
    return JSON.parse(json) as T;
  } catch (error) {
    if (error instanceof PlaintextCodecError) throw error;
    fail();
  }
}

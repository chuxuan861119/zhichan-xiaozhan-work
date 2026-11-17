/**
 * 生成 RFC 4122 v4 UUID。
 *
 * 渲染进程以 `patent-app://` 自定义协议加载时并不总是安全上下文
 * （isSecureContext 可能为 false），此时 `crypto.randomUUID` 不存在，
 * 但 `crypto.getRandomValues` 始终可用。因此不能直接依赖
 * `globalThis.crypto.randomUUID`，必须提供降级实现。
 */
export function randomUuid(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ExpectedPeer = { parent: Window; origin: string; nonce: string };
type HandshakeEvent = { source: unknown; origin: string; ports: readonly unknown[]; data: unknown };

export function isTrustedKlecksHandshake(event: HandshakeEvent, expected: ExpectedPeer): boolean {
  if (
    !expected.origin ||
    expected.origin === "null" ||
    expected.origin === "*" ||
    !/^[a-f0-9]{64}$/u.test(expected.nonce) ||
    event.source !== expected.parent ||
    event.origin !== expected.origin ||
    event.ports.length !== 1
  )
    return false;
  const data = event.data;
  return (
    typeof data === "object" &&
    data !== null &&
    Object.keys(data).length === 3 &&
    "type" in data &&
    data.type === "klecks:connect" &&
    "version" in data &&
    data.version === 1 &&
    "nonce" in data &&
    data.nonce === expected.nonce
  );
}

/** One connection per frame generation; fresh nonce required after reload. No wildcard origins. */
export function bindKlecksFrameHandshake(
  host: Window,
  expected: ExpectedPeer,
  attach: (port: MessagePort) => () => void,
): () => void {
  let release: (() => void) | null = null;
  let connected = false;
  const receive = (event: MessageEvent<unknown>) => {
    if (connected || !isTrustedKlecksHandshake(event, expected)) return;
    const port = event.ports[0];
    if (!port) return;
    connected = true;
    host.removeEventListener("message", receive);
    try {
      release = attach(port);
      port.postMessage({ type: "klecks:ready", version: 1, nonce: expected.nonce });
    } catch {
      release?.();
      release = null;
      port.close();
    }
  };
  host.addEventListener("message", receive);
  return () => {
    connected = true;
    host.removeEventListener("message", receive);
    release?.();
    release = null;
  };
}

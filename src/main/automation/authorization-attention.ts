export type PendingAuthorization = { pairId: string; expiresAt: number };
export type AuthorizationAttentionHost = {
  isFocused(): boolean;
  notify(onClick: () => void): () => void;
  requestAttention(): () => void;
  openAuthorization(): void;
};
export function createAuthorizationAttention(host: AuthorizationAttentionHost) {
  let current: PendingAuthorization | undefined;
  let requests: readonly PendingAuthorization[] = [];
  let alerted = false;
  let disposed = false;
  let closeNotification: (() => void) | undefined;
  let cancelAttention: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const quietly = (action?: () => void) => {
    try {
      action?.();
    } catch {}
  };
  function clearSignals() {
    quietly(closeNotification);
    quietly(cancelAttention);
    closeNotification = undefined;
    cancelAttention = undefined;
  }
  function update(next: readonly PendingAuthorization[]) {
    if (disposed) return;
    requests = next;
    const head = requests.find((request) => request.expiresAt > Date.now());
    if (head?.pairId !== current?.pairId) {
      clearSignals();
      if (timer) clearTimeout(timer);
      current = head;
      alerted = false;
      if (head) {
        timer = setTimeout(() => update(requests), Math.max(1, head.expiresAt - Date.now()));
        timer.unref?.();
      }
    }
    if (!current) return;
    if (host.isFocused()) {
      clearSignals();
      return;
    }
    if (alerted) return;
    alerted = true;
    const pairId = current.pairId;
    try {
      cancelAttention = host.requestAttention();
    } catch {}
    try {
      closeNotification = host.notify(() => {
        if (!disposed && current?.pairId === pairId && current.expiresAt > Date.now())
          quietly(host.openAuthorization);
      });
    } catch {}
  }
  return {
    update,
    dispose() {
      disposed = true;
      current = undefined;
      if (timer) clearTimeout(timer);
      clearSignals();
    },
  };
}

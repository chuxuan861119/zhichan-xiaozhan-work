export class DrawingImportJobs {
  #active = new Map<string, { sessionId: string; controller: AbortController }>();
  start(owner: number, sessionId: string, operationId: string) {
    const key = `${owner}:${operationId}`;
    if (this.#active.has(key)) throw new Error("图纸正在导入，请勿重复提交。");
    const controller = new AbortController();
    this.#active.set(key, { sessionId, controller });
    return controller;
  }
  cancel(owner: number, sessionId: string, operationId: string) {
    const active = this.#active.get(`${owner}:${operationId}`);
    if (!active || active.sessionId !== sessionId) return false;
    active.controller.abort();
    return true;
  }
  finish(owner: number, operationId: string) {
    this.#active.delete(`${owner}:${operationId}`);
  }
}

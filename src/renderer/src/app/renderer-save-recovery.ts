type RetainedSave = {
  save(): Promise<void>;
  running?: Promise<boolean>;
};

// React may unmount its entire tree after a rendering error. These tasks must
// outlive that tree; failures stay available until an explicit retry succeeds.
export class RendererSaveRecovery {
  readonly #tasks = new Map<object, RetainedSave>();

  retain(owner: object, save: () => Promise<void>): void {
    if (this.#tasks.has(owner)) return;
    const task = { save };
    this.#tasks.set(owner, task);
    void this.#run(owner, task);
  }

  async flush(): Promise<boolean> {
    // Let unmount cleanups hand off their queues before taking the first batch.
    await Promise.resolve();
    const attempted = new Set<RetainedSave>();
    while (true) {
      const batch = [...this.#tasks].filter(([, task]) => !attempted.has(task));
      if (batch.length === 0) return this.#tasks.size === 0;
      await Promise.all(
        batch.map(([owner, task]) => {
          attempted.add(task);
          return this.#run(owner, task);
        }),
      );
    }
  }

  #run(owner: object, task: RetainedSave): Promise<boolean> {
    if (task.running) return task.running;
    task.running = Promise.resolve()
      .then(task.save)
      .then(
        () => {
          this.#tasks.delete(owner);
          return true;
        },
        // Failure is retained and returned to the recovery screen, never treated
        // as a successful save or an authorization to reload/exit.
        () => false,
      )
      .finally(() => {
        delete task.running;
      });
    return task.running;
  }
}

export const rendererSaveRecovery = new RendererSaveRecovery();

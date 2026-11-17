import {
  DataTransferQuiescence,
  DataTransferQuiescenceError,
  type SuspendableService,
} from "./data-transfer-quiescence.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function suspendable(name: string, events: string[], resumeError?: Error): SuspendableService {
  return {
    suspend: vi.fn(async () => {
      events.push(`${name}.pause`);
      return async () => {
        events.push(`${name}.resume`);
        if (resumeError) throw resumeError;
      };
    }),
  };
}

function objectGraphText(value: unknown): string {
  const fragments: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown) => {
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
      fragments.push(String(candidate));
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      fragments.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor) continue;
      if ("value" in descriptor) visit(descriptor.value);
      if (descriptor.get) fragments.push(String(descriptor.get));
      if (descriptor.set) fragments.push(String(descriptor.set));
    }
  };
  visit(value);
  return fragments.join("\n");
}

function secretFailure(label: string): Error {
  const secret = `D:\\客户\\绝密-${label}.patdoc`;
  const error = Object.assign(new Error(secret), {
    path: secret,
    sql: `SELECT secret_body FROM patents WHERE name = '${label}'`,
  });
  error.stack = `${secret}\n    at ${label} (D:\\source\\private.ts:42:7)`;
  return error;
}

test("waits for every writer and releases paused services once in reverse order", async () => {
  const events: string[] = [];
  const quiescence = new DataTransferQuiescence({
    snapshot: suspendable("snapshot", events),
    backup: suspendable("backup", events),
    trash: suspendable("trash", events),
    assets: {
      waitForIdle: vi.fn(async () => {
        events.push("assets.drain");
        return { stagedSessionIds: [] };
      }),
    },
    drafts: {
      waitForIdle: vi.fn(async () => {
        events.push("drafts.drain");
      }),
    },
  });

  const lease = await quiescence.acquire();
  expect(events).toEqual([
    "snapshot.pause",
    "backup.pause",
    "trash.pause",
    "assets.drain",
    "drafts.drain",
  ]);

  await Promise.all([lease.release(), lease.release()]);
  await lease.release();
  expect(events.slice(-3)).toEqual(["trash.resume", "backup.resume", "snapshot.resume"]);
  expect(events.filter((event) => event.endsWith(".resume"))).toHaveLength(3);
});

test("rejects a nested acquire without disturbing the first lease", async () => {
  const events: string[] = [];
  const quiescence = new DataTransferQuiescence({
    snapshot: suspendable("snapshot", events),
    backup: suspendable("backup", events),
    trash: suspendable("trash", events),
    assets: { waitForIdle: async () => ({ stagedSessionIds: [] }) },
    drafts: { waitForIdle: async () => undefined },
  });

  const first = await quiescence.acquire();
  await expect(quiescence.acquire()).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  expect(events).not.toContain("snapshot.resume");

  await first.release();
  const second = await quiescence.acquire();
  await second.release();
});

test.each(["snapshot", "backup", "trash", "assets", "drafts"] as const)(
  "restores acquired services and sanitizes a %s acquisition failure",
  async (failingStage) => {
    const failure = secretFailure(failingStage);
    const events: string[] = [];
    const service = (name: "snapshot" | "backup" | "trash"): SuspendableService => ({
      suspend: async () => {
        events.push(`${name}.pause`);
        if (failingStage === name) throw failure;
        return async () => {
          events.push(`${name}.resume`);
        };
      },
    });
    const quiescence = new DataTransferQuiescence({
      snapshot: service("snapshot"),
      backup: service("backup"),
      trash: service("trash"),
      assets: {
        waitForIdle: async () => {
          events.push("assets.drain");
          if (failingStage === "assets") throw failure;
          return { stagedSessionIds: [] };
        },
      },
      drafts: {
        waitForIdle: async () => {
          events.push("drafts.drain");
          if (failingStage === "drafts") throw failure;
        },
      },
    });

    const error = await quiescence.acquire().catch((caught: unknown) => caught);
    const phase = ["snapshot", "backup", "trash"].includes(failingStage) ? "suspend" : "drain";
    expect(error).toBeInstanceOf(DataTransferQuiescenceError);
    expect(error).toMatchObject({
      code: "SOURCE_SAVE_FAILED",
      firstFailure: { service: failingStage, phase, code: "SOURCE_SAVE_FAILED" },
      failures: [{ service: failingStage, phase, code: "SOURCE_SAVE_FAILED" }],
    });
    expect(objectGraphText(error)).not.toMatch(/绝密|secret_body|private\.ts/iu);
    expect(JSON.stringify(error)).not.toMatch(/绝密|secret_body|private\.ts/iu);
    const suspendStages = ["snapshot", "backup", "trash"];
    const failingSuspendIndex = suspendStages.indexOf(failingStage);
    const successfulPauses =
      failingSuspendIndex === -1 ? suspendStages : suspendStages.slice(0, failingSuspendIndex);
    expect(events.filter((event) => event.endsWith(".resume"))).toEqual(
      successfulPauses.reverse().map((name) => `${name}.resume`),
    );
  },
);

test("reports staged assets only as a sanitized source-save failure after draining drafts", async () => {
  const secretSessionId = "session-customer-secret";
  const events: string[] = [];
  const quiescence = new DataTransferQuiescence({
    snapshot: suspendable("snapshot", events),
    backup: suspendable("backup", events),
    trash: suspendable("trash", events),
    assets: {
      waitForIdle: async () => {
        events.push("assets.drain");
        return { stagedSessionIds: [secretSessionId] };
      },
    },
    drafts: {
      waitForIdle: async () => {
        events.push("drafts.drain");
      },
    },
  });

  const error = await quiescence.acquire().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  expect(events).toContain("drafts.drain");
  expect(events.slice(-3)).toEqual(["trash.resume", "backup.resume", "snapshot.resume"]);
  expect(JSON.stringify(error)).not.toContain(secretSessionId);
  expect(String(error)).not.toContain(secretSessionId);
});

test("normalizes a draft drain rejection without exposing its document or path", async () => {
  const secret = "D:\\客户\\绝密专利.patdoc";
  const quiescence = new DataTransferQuiescence({
    snapshot: suspendable("snapshot", []),
    backup: suspendable("backup", []),
    trash: suspendable("trash", []),
    assets: { waitForIdle: async () => ({ stagedSessionIds: [] }) },
    drafts: { waitForIdle: async () => Promise.reject(new Error(secret)) },
  });

  const error = await quiescence.acquire().catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "SOURCE_SAVE_FAILED" });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(String(error)).not.toContain(secret);
});

test("keeps the first reverse-resume error and exposes secondary diagnostics", async () => {
  const events: string[] = [];
  const trashFailure = secretFailure("trash-resume");
  const backupFailure = secretFailure("backup-resume");
  const quiescence = new DataTransferQuiescence({
    snapshot: suspendable("snapshot", events),
    backup: suspendable("backup", events, backupFailure),
    trash: suspendable("trash", events, trashFailure),
    assets: { waitForIdle: async () => ({ stagedSessionIds: [] }) },
    drafts: { waitForIdle: async () => undefined },
  });
  const lease = await quiescence.acquire();

  const error = await lease.release().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(DataTransferQuiescenceError);
  if (!(error instanceof DataTransferQuiescenceError)) throw new Error("expected safe error");
  expect(error).toMatchObject({
    name: "DataTransferQuiescenceError",
    message: "Background library services could not be quiesced safely.",
    code: "SOURCE_SAVE_FAILED",
    firstFailure: { service: "trash", phase: "resume", code: "SOURCE_SAVE_FAILED" },
    failures: [
      { service: "trash", phase: "resume", code: "SOURCE_SAVE_FAILED" },
      { service: "backup", phase: "resume", code: "SOURCE_SAVE_FAILED" },
    ],
  });
  expect(Reflect.ownKeys(error)).not.toContain("stack");
  expect(Reflect.ownKeys(error)).not.toContain("cause");
  expect(Reflect.ownKeys(error)).not.toContain("secondaryErrors");
  expect(Object.isFrozen(error.firstFailure)).toBe(true);
  expect(Object.isFrozen(error.failures)).toBe(true);
  expect(error.failures.every(Object.isFrozen)).toBe(true);
  expect(objectGraphText(error)).not.toMatch(/绝密|secret_body|private\.ts/iu);
  expect(JSON.stringify(error)).not.toMatch(/绝密|secret_body|private\.ts/iu);
  expect(events.slice(-3)).toEqual(["trash.resume", "backup.resume", "snapshot.resume"]);
  await expect(lease.release()).rejects.toBe(error);
});

test("does not finish acquire before a suspend promise settles", async () => {
  const pause = deferred<() => Promise<void>>();
  const quiescence = new DataTransferQuiescence({
    snapshot: { suspend: () => pause.promise },
    backup: suspendable("backup", []),
    trash: suspendable("trash", []),
    assets: { waitForIdle: async () => ({ stagedSessionIds: [] }) },
    drafts: { waitForIdle: async () => undefined },
  });
  let acquired = false;
  const operation = quiescence.acquire().then((lease) => {
    acquired = true;
    return lease;
  });

  await Promise.resolve();
  expect(acquired).toBe(false);
  pause.resolve(async () => undefined);
  const lease = await operation;
  await lease.release();
});

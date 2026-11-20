import type { ApplicationClosePreparation } from "../../app/application-close-coordinator";
import { KlecksCloseCoordinator } from "./klecks-close-coordinator";

type Dependencies = Omit<ConstructorParameters<typeof KlecksCloseCoordinator>[0], "close">;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Hold the existing close coordinator at decision/exit barriers; never release a case here. */
export function prepareKlecksApplicationClose(
  dependencies: Dependencies,
): Promise<false | ApplicationClosePreparation> {
  const prepared = deferred<false | ApplicationClosePreparation>();
  const begin = deferred<"save" | "discard" | "cancel">();
  const committed = deferred<boolean>();
  const finish = deferred<boolean>();
  let announced = false,
    cancelled = false,
    approved: "save" | "discard" = "save";
  let work: Promise<boolean>;
  const plan: ApplicationClosePreparation = {
    commit: async () => {
      if (cancelled) return false;
      begin.resolve(approved);
      return committed.promise;
    },
    cancel: async () => {
      cancelled = true;
      begin.resolve("cancel");
      finish.resolve(false);
      await work.then(
        () => {},
        () => {},
      );
      await coordinator.releaseInput();
    },
  };
  const announce = () => {
    if (!announced) {
      announced = true;
      prepared.resolve(plan);
    }
  };
  const coordinator = new KlecksCloseCoordinator({
    ...dependencies,
    choose: async (dirty) => {
      const choice = await dependencies.choose(dirty);
      if (choice === "cancel") return choice;
      approved = choice;
      announce();
      return begin.promise;
    },
    close: async () => {
      announce();
      committed.resolve(true);
      return finish.promise;
    },
  });
  // Always observe both rejection channels, including a cancellation before commit is requested.
  void committed.promise.catch(() => {});
  work = coordinator.run();
  void work.then(
    () => {
      if (!announced) prepared.resolve(false);
      committed.resolve(false);
    },
    (error) => {
      if (!announced) prepared.reject(error);
      committed.reject(error);
    },
  );
  return prepared.promise;
}

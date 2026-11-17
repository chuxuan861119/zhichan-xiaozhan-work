import { beginWorkspaceLayoutTransition } from "./workspace-layout-transition";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function animation(finished: Promise<void>) {
  return { finished, cancel: vi.fn() } as unknown as Animation;
}

afterEach(() => {
  document.documentElement.className = "";
  delete document.documentElement.dataset.reducedMotion;
  document.body.replaceChildren();
});

test("uses the original 200ms timing for both phases while suppressing child layout transitions", async () => {
  const leaveFinished = deferred<void>();
  const enterFinished = deferred<void>();
  const stage = document.createElement("div");
  stage.className = "app-view-transition-stage";
  const animate = vi
    .fn()
    .mockReturnValueOnce(animation(leaveFinished.promise))
    .mockReturnValueOnce(animation(enterFinished.promise));
  stage.animate = animate;
  document.body.append(stage);
  const update = vi.fn();

  const transition = beginWorkspaceLayoutTransition("enter-columns");
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    true,
  );
  expect(
    document.documentElement.classList.contains("workspace-layout-view-transition-enter-columns"),
  ).toBe(true);
  expect(animate).toHaveBeenCalledWith(
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(-5px)" },
    ],
    { duration: 200, easing: "ease-in-out", fill: "forwards" },
  );

  const completion = transition.commit(update);
  expect(update).not.toHaveBeenCalled();
  leaveFinished.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(update).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenLastCalledWith(
    [
      { opacity: 0, transform: "translateY(7px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 200, easing: "ease-in-out", fill: "forwards" },
  );
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    true,
  );

  enterFinished.resolve();
  await completion;
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    false,
  );
});

test("cancels a prepared transition without committing an intermediate layout", async () => {
  const stage = document.createElement("div");
  stage.className = "app-view-transition-stage";
  const leaveAnimation = animation(new Promise(() => undefined));
  stage.animate = vi.fn(() => leaveAnimation);
  document.body.append(stage);
  const update = vi.fn();
  const transition = beginWorkspaceLayoutTransition("exit-dual");

  transition.cancel();
  await transition.commit(update);

  expect(update).not.toHaveBeenCalled();
  expect(leaveAnimation.cancel).toHaveBeenCalledOnce();
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    false,
  );
});

test("commits immediately when reduced motion is enabled", async () => {
  document.documentElement.dataset.reducedMotion = "true";
  const stage = document.createElement("div");
  stage.className = "app-view-transition-stage";
  const animate = vi.fn();
  stage.animate = animate;
  document.body.append(stage);
  const update = vi.fn();

  await beginWorkspaceLayoutTransition("enter-dual").commit(update);

  expect(update).toHaveBeenCalledOnce();
  expect(animate).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    false,
  );
});

test("inverse intent resumes the current paint and prevents the cancelled layout commit", async () => {
  const stage = document.createElement("div");
  stage.className = "app-view-transition-stage";
  const oldAnimation = animation(Promise.resolve());
  const animate = vi.fn(() => animation(Promise.resolve())).mockReturnValueOnce(oldAnimation);
  stage.animate = animate;
  document.body.append(stage);
  const oldUpdate = vi.fn();
  const old = beginWorkspaceLayoutTransition("exit-dual");
  stage.style.opacity = "0.42";
  stage.style.transform = "translateY(3px)";
  const latest = beginWorkspaceLayoutTransition("enter-dual");
  await old.commit(oldUpdate);
  await latest.commit(() => {}, { retainLayout: true });
  expect(old.cancelled).toBe(true);
  expect(oldUpdate).not.toHaveBeenCalled();
  expect(animate).toHaveBeenLastCalledWith(
    [
      { opacity: 0.42, transform: "translateY(3px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 200, easing: "ease-in-out", fill: "forwards" },
  );
  expect(document.documentElement.classList.contains("workspace-layout-view-transition")).toBe(
    false,
  );
});

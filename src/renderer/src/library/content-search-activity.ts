// A bounded IPC heartbeat, not one message per pointer event or keystroke.
export function installContentSearchActivity() {
  let lastSent = 0;
  const notify = () => {
    const now = Date.now();
    if (now - lastSent < 2000) return;
    lastSent = now;
    window.patentApi?.contentSearch?.activity();
  };
  const events = ["pointerdown", "pointermove", "keydown", "wheel", "input"] as const;
  for (const event of events)
    window.addEventListener(event, notify, { capture: true, passive: true });
  return () => {
    for (const event of events) window.removeEventListener(event, notify, true);
  };
}

// Diagnostic-only replacement for signal-exit. Does not register native signals.
// Abrupt termination can leave a temporary file, as with SIGKILL on other systems.
const callbacks = new Set();
function cleanup() {
  for (const callback of callbacks) callback();
  callbacks.clear();
}
exports.onExit = (callback) => {
  if (callbacks.size === 0) process.once("exit", cleanup);
  callbacks.add(callback);
  return () => {
    callbacks.delete(callback);
    if (callbacks.size === 0) process.removeListener("exit", cleanup);
  };
};

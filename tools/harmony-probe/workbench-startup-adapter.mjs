function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`Expected one adapter anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function adaptWorkbenchStartup(source) {
  const initialized = replaceOnce(
    source,
    'await logger.log("info", { event: "app.started" });',
    'await globalThis.__harmonyAdaptersReady; await logger.log("info", { event: "app.started" });',
  );
  return replaceOnce(
    initialized,
    ".catch((error: unknown) => {\n      return reportStartupFailure(",
    ".catch((error: unknown) => {\n      globalThis.__harmonyStartupError(error);\n      return reportStartupFailure(",
  );
}

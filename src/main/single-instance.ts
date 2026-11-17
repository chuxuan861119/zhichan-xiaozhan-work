type OpenPathWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show?(): void;
  focus(): void;
  webContents: { send(channel: string, path: string): void };
};

export function findFirstPatdocArgument(_argv: readonly string[]): string | null {
  return _argv.find((argument) => isPatdocPath(argument)) ?? null;
}

export function sendPatdocOpenCommand(_window: OpenPathWindow, _path: string): boolean {
  if (_window.isDestroyed() || !isPatdocPath(_path)) return false;
  if (_window.isMinimized()) _window.restore();
  _window.show?.();
  _window.focus();
  _window.webContents.send("open-path", _path);
  return true;
}

function isPatdocPath(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(".patdoc");
}

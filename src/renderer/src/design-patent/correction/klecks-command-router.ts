import type { KlecksKeyboardCommand } from "./klecks-keyboard";
import { KlecksOperationRejected } from "./klecks-operation-error";

export type KlecksCommandDriver = {
  workspace: {
    readonly document: {
      undo(): void;
      canUndo?(): boolean;
      canRedo?(): boolean;
      redo(): void;
      selectAll(): void;
      deselect(): void;
      reselect?(): void;
      invertSelection?(): void;
    } | null;
    copy(cut?: boolean, merged?: boolean): void;
    paste(inPlace?: boolean): void;
  };
  pending(): boolean;
  changed(): void;
  error(error: unknown): void;
  /** Tools, transform previews and persistence are owned by host UI/coordinators. */
  host(command: KlecksKeyboardCommand): boolean;
};

/** Same synchronous acceptance result for buttons, menu messages and keydown. */
export function routeKlecksCommand(
  command: KlecksKeyboardCommand,
  driver: KlecksCommandDriver,
): boolean {
  if (driver.pending() || !driver.workspace.document) return false;
  try {
    const image = driver.workspace.document;
    switch (command.action) {
      case "undo":
        if (image.canUndo?.() === false)
          throw new KlecksOperationRejected("当前图片没有可撤销的操作。");
        image.undo();
        break;
      case "redo":
        if (image.canRedo?.() === false)
          throw new KlecksOperationRejected("当前图片没有可重做的操作。");
        image.redo();
        break;
      case "copy":
        driver.workspace.copy(false, false);
        break;
      case "copyMerged":
        driver.workspace.copy(false, true);
        break;
      case "cut":
        driver.workspace.copy(true, false);
        break;
      case "paste":
        driver.workspace.paste(false);
        break;
      case "pasteInPlace":
        driver.workspace.paste(true);
        break;
      case "selectAll":
        image.selectAll();
        break;
      case "deselect":
        image.deselect();
        break;
      case "reselect":
        if (!image.reselect) throw new Error("当前图片不支持重新选择。");
        image.reselect();
        break;
      case "invertSelection":
        if (!image.invertSelection) throw new Error("当前图片不支持反选。");
        image.invertSelection();
        break;
      default:
        if (!driver.host(command)) return false;
    }
    driver.changed();
  } catch (error) {
    // A recognized but failed command must not fall through to browser paste/undo/save.
    driver.error(error);
  }
  return true;
}

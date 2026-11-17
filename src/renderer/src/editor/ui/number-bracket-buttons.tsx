import { NumberBracketsIcon } from "../../shared/number-brackets-help";
import type { EditorCommand } from "../commands";

export function NumberBracketButton({
  add,
  enabled,
  menu = false,
  onCommand,
}: {
  add: boolean;
  enabled: boolean;
  menu?: boolean;
  onCommand(command: EditorCommand): void;
}) {
  const label = add ? "数字加括号" : "数字去括号";
  return (
    <button
      type="button"
      role={menu ? "menuitem" : undefined}
      className={menu ? undefined : "tool-button"}
      aria-label={label}
      data-number-brackets={add ? "add" : "remove"}
      disabled={!enabled}
      aria-disabled={!enabled}
      onClick={() => onCommand(add ? "add-number-brackets" : "remove-number-brackets")}
    >
      <NumberBracketsIcon add={add} />
      {menu ? label : null}
    </button>
  );
}

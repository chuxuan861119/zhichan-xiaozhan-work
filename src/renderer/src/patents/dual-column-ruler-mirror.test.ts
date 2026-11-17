import { expect, test } from "vitest";
import { syncRulerMirror } from "./dual-column-ruler-mirror";

function ruler(markup: string) {
  const element = document.createElement("aside");
  element.innerHTML = markup;
  return element;
}

test("updates marker state in place without detaching the ruler or its labels", () => {
  const current = ruler(
    '<div><button data-active="false" style="top: 20px"><span>权利要求1</span></button></div>',
  );
  const next = ruler(
    '<div><button data-active="true" style="top: 30px"><span>权利要求1</span></button></div>',
  );
  const marker = current.querySelector("button");
  const label = current.querySelector("span");
  syncRulerMirror(current, next);
  expect(current.querySelector("button")).toBe(marker);
  expect(current.querySelector("span")).toBe(label);
  expect(current.isEqualNode(next)).toBe(true);
});

test("unchanged state performs no DOM writes", () => {
  const current = ruler('<button data-active="true">权利要求1</button>');
  const observer = new MutationObserver(() => {});
  observer.observe(current, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  syncRulerMirror(current, current.cloneNode(true) as HTMLElement);
  expect(observer.takeRecords()).toEqual([]);
  observer.disconnect();
});

test("syncs new labels, removed attributes and added or removed markers", () => {
  const current = ruler(
    '<div data-navigation="true"><button>旧标题</button><button>2</button></div>',
  );
  const next = ruler("<div><button>新标题</button><button>2</button><button>3</button></div>");
  const first = current.querySelector("button");
  syncRulerMirror(current, next);
  expect(current.querySelector("button")).toBe(first);
  expect(current.isEqualNode(next)).toBe(true);
  const shorter = ruler("<div><span>不同结构</span></div>");
  syncRulerMirror(current, shorter);
  expect(current.isEqualNode(shorter)).toBe(true);
});

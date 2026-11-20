import type { DesignPatentImageOperation } from "../../../../shared/patent/design-patent";

export type DesignCorrectionSession = {
  viewId: string;
  committed: DesignPatentImageOperation[];
  past: DesignPatentImageOperation[][];
  draft: DesignPatentImageOperation[];
  future: DesignPatentImageOperation[][];
  render: { status: "idle" | "loading" | "ready" | "error"; requestId: number };
};

type Action =
  | { type: "replace-draft"; operations: readonly DesignPatentImageOperation[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" | "cancel" | "apply" }
  | { type: "switch-view"; viewId: string; operations: readonly DesignPatentImageOperation[] }
  | { type: "render-start"; requestId: number }
  | { type: "render-ready" | "render-error"; requestId: number };

const copy = (operations: readonly DesignPatentImageOperation[]) => [...operations];

export function createDesignCorrectionSession(
  viewId: string,
  operations: readonly DesignPatentImageOperation[],
): DesignCorrectionSession {
  return {
    viewId,
    committed: copy(operations),
    past: [],
    draft: copy(operations),
    future: [],
    render: { status: "idle", requestId: 0 },
  };
}

export function designCorrectionReducer(
  state: DesignCorrectionSession,
  action: Action,
): DesignCorrectionSession {
  switch (action.type) {
    case "replace-draft":
      return {
        ...state,
        past: [...state.past, copy(state.draft)],
        draft: copy(action.operations),
        future: [],
      };
    case "undo": {
      const previous = state.past.at(-1);
      return previous === undefined
        ? state
        : {
            ...state,
            past: state.past.slice(0, -1),
            draft: copy(previous),
            future: [copy(state.draft), ...state.future],
          };
    }
    case "redo": {
      const next = state.future[0];
      return next === undefined
        ? state
        : {
            ...state,
            past: [...state.past, copy(state.draft)],
            draft: copy(next),
            future: state.future.slice(1),
          };
    }
    case "reset":
    case "cancel":
      return { ...state, past: [], draft: copy(state.committed), future: [] };
    case "apply":
      return { ...state, committed: copy(state.draft), past: [], future: [] };
    case "switch-view":
      return createDesignCorrectionSession(action.viewId, action.operations);
    case "render-start":
      return { ...state, render: { status: "loading", requestId: action.requestId } };
    case "render-ready":
      return action.requestId === state.render.requestId
        ? { ...state, render: { ...state.render, status: "ready" } }
        : state;
    case "render-error":
      return action.requestId === state.render.requestId
        ? { ...state, render: { ...state.render, status: "error" } }
        : state;
  }
}

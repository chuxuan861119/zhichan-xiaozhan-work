import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ReferenceMarkIssueLocation } from "../../../../shared/patent/reference-mark-issue-locator";

type MappedIssue = Readonly<{
  locationId: string;
  from: number;
  to: number;
  active: boolean;
}>;

type IssueHighlightState = Readonly<{
  locations: readonly ReferenceMarkIssueLocation[];
  activeLocationId: string | null;
  matches: readonly MappedIssue[];
  decorations: DecorationSet;
}>;

type IssueHighlightMeta = Readonly<{
  locations: readonly ReferenceMarkIssueLocation[];
  activeLocationId: string | null;
}>;

const referenceMarkIssueHighlightKey = new PluginKey<IssueHighlightState>(
  "referenceMarkIssueHighlights",
);

function mapLocations(
  document: ProseMirrorNode,
  locations: readonly ReferenceMarkIssueLocation[],
  activeLocationId: string | null,
): MappedIssue[] {
  const byNodeId = new Map<string, ReferenceMarkIssueLocation[]>();
  for (const location of locations) {
    const current = byNodeId.get(location.nodeId) ?? [];
    current.push(location);
    byNodeId.set(location.nodeId, current);
  }
  const matches: MappedIssue[] = [];
  document.descendants((node, position) => {
    if (!node.isTextblock) return true;
    const nodeId = typeof node.attrs.nodeId === "string" ? node.attrs.nodeId : null;
    if (!nodeId) return true;
    for (const location of byNodeId.get(nodeId) ?? []) {
      if (location.from < 0 || location.to <= location.from || location.to > node.content.size) {
        continue;
      }
      if (node.textBetween(location.from, location.to, " ", " ") !== location.text) continue;
      matches.push({
        locationId: location.locationId,
        from: position + 1 + location.from,
        to: position + 1 + location.to,
        active: location.locationId === activeLocationId,
      });
    }
    return true;
  });
  return matches.sort((left, right) => left.from - right.from || left.to - right.to);
}

function createState(
  document: ProseMirrorNode,
  locations: readonly ReferenceMarkIssueLocation[],
  activeLocationId: string | null,
): IssueHighlightState {
  const matches = mapLocations(document, locations, activeLocationId);
  return {
    locations,
    activeLocationId,
    matches,
    decorations: DecorationSet.create(
      document,
      matches.map((match) =>
        Decoration.inline(match.from, match.to, {
          class: `reference-mark-issue-match${match.active ? " is-active" : ""}`,
          "data-reference-mark-issue-location": match.locationId,
          ...(match.active ? { "data-reference-mark-issue-active": "true" } : {}),
        }),
      ),
    ),
  };
}

export const ReferenceMarkIssueHighlights = Extension.create({
  name: "referenceMarkIssueHighlights",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: referenceMarkIssueHighlightKey,
        state: {
          init: (_, state) => createState(state.doc, [], null),
          apply(transaction, previous) {
            const meta = transaction.getMeta(referenceMarkIssueHighlightKey) as
              | IssueHighlightMeta
              | undefined;
            if (!meta && !transaction.docChanged) return previous;
            return createState(
              transaction.doc,
              meta?.locations ?? previous.locations,
              meta ? meta.activeLocationId : previous.activeLocationId,
            );
          },
        },
        props: {
          decorations(state) {
            return (
              referenceMarkIssueHighlightKey.getState(state)?.decorations ?? DecorationSet.empty
            );
          },
        },
      }),
    ];
  },
});

export function setReferenceMarkIssueHighlights(
  editor: Editor,
  locations: readonly ReferenceMarkIssueLocation[],
  activeLocationId: string | null,
): void {
  if (editor.isDestroyed) return;
  const current = referenceMarkIssueHighlightKey.getState(editor.state);
  if (
    current?.activeLocationId === activeLocationId &&
    JSON.stringify(current.locations) === JSON.stringify(locations)
  ) {
    return;
  }
  editor.view.dispatch(
    editor.state.tr.setMeta(referenceMarkIssueHighlightKey, {
      locations: locations.map((location) => ({ ...location })),
      activeLocationId,
    } satisfies IssueHighlightMeta),
  );
}

export function referenceMarkIssueHighlightSnapshot(editor: Editor): readonly MappedIssue[] {
  return referenceMarkIssueHighlightKey.getState(editor.state)?.matches ?? [];
}

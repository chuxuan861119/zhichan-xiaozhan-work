import { createContext, type ReactNode, useContext } from "react";

export const ActiveEditorSessionContext = createContext<string | null | undefined>(undefined);
const EditorSessionOwnerContext = createContext<string | undefined>(undefined);

/** React context follows portals, unlike the hidden document's DOM ancestry. */
export function EditorSessionScope({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  return (
    <EditorSessionOwnerContext.Provider value={sessionId}>
      {children}
    </EditorSessionOwnerContext.Provider>
  );
}

export function useEditorSessionVisible(): boolean {
  const active = useContext(ActiveEditorSessionContext);
  const owner = useContext(EditorSessionOwnerContext);
  return active === undefined || owner === undefined || active === owner;
}

export function editorBelongsToSession(editorId: string, sessionId: string): boolean {
  return editorId === sessionId || editorId.startsWith(`${sessionId}:`);
}

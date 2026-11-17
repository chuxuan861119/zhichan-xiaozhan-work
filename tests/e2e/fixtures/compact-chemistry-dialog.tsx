import { createRoot } from "react-dom/client";
import { ChemistryDialog } from "../../../src/renderer/src/editor/chemistry-dialog";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ChemistryDialog
      sessionId="compact-layout"
      request={{ type: "new", initialKind: "equation" }}
      displayMode="modeless"
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

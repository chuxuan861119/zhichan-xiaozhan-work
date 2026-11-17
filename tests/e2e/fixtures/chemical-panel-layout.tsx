import "katex/contrib/mhchem";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChemicalPeriodicPanel } from "../../../src/renderer/src/editor/ui/chemical-periodic-panel";
import { SpatialCollapse } from "../../../src/renderer/src/shared/spatial-collapse";

function Fixture() {
  const [token, setToken] = useState("");
  return (
    <section className="formula-dialog chemistry-dialog">
      <header>
        <h2>插入化学公式</h2>
      </header>
      <output aria-label="插入结果">{token}</output>
      <SpatialCollapse open className="chemistry-periodic-collapse" animateInitial={false}>
        <div className="chemistry-periodic-tray is-open">
          <ChemicalPeriodicPanel onInsertElement={setToken} />
        </div>
      </SpatialCollapse>
      <footer>
        <button type="button">确定</button>
      </footer>
    </section>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);

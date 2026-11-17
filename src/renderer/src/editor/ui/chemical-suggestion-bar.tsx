import katex from "katex";
import "katex/contrib/mhchem";
import { useEffect, useRef } from "react";
import type { ChemicalScriptSuggestion } from "../chemical-script-suggestions";

function CandidateFormula({ latex, fallback }: { latex: string; fallback: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    try {
      katex.render(String.raw`\ce{${latex}}`, container, {
        throwOnError: true,
        strict: "warn",
        trust: false,
      });
    } catch {
      container.textContent = fallback;
    }
  }, [fallback, latex]);

  return <span ref={containerRef} aria-hidden="true" />;
}

export function ChemicalSuggestionBar({
  candidates,
  activeIndex,
  onActivate,
  onAccept,
}: {
  candidates: readonly ChemicalScriptSuggestion[];
  activeIndex: number;
  onActivate(index: number): void;
  onAccept(index: number): void;
}) {
  if (candidates.length === 0) return null;

  return (
    <section className="chemistry-suggestion-bar" aria-label="化学式格式候选">
      <span className="chemistry-suggestion-label">格式候选</span>
      <div role="listbox" aria-label="化学式格式候选">
        {candidates.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="option"
            aria-label={`使用候选 ${candidate.displayText}`}
            aria-selected={index === activeIndex}
            className="chemistry-suggestion-option"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onActivate(index);
              onAccept(index);
            }}
          >
            <CandidateFormula latex={candidate.latex} fallback={candidate.displayText} />
          </button>
        ))}
      </div>
      <span className="chemistry-suggestion-help">Tab 接受 · ↑↓ 切换 · Esc 隐藏</span>
    </section>
  );
}

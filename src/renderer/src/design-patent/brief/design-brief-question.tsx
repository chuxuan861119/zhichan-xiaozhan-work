import type { ReactNode } from "react";

export function DesignBriefQuestion({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: The caller supplies the nested form control.
    <label className="design-brief-question">
      <span>{label}</span>
      {children}
    </label>
  );
}

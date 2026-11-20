import type { ReactNode } from "react";

/** Keeps correction controls separate from the canvas so all changes remain recipe-based. */
export function DesignCorrectionTools({ children }: { children: ReactNode }) {
  return <aside aria-label="校正控制">{children}</aside>;
}

import type { PatentBookDocument } from "../../../src/shared/document/model.js";

export type TypographyLine = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  from: number;
  to: number;
  text: string;
};

export type TypographyHarness = {
  ready(): boolean;
  lines(): TypographyLine[];
  selection(): {
    from: number;
    to: number;
    anchor: number;
    head: number;
    top: number | null;
    left: number | null;
  };
  load(html: string): boolean;
  bounds(): { left: number; right: number; top: number; bottom: number };
  align(value: "left" | "right" | "center" | "justify"): boolean;
  fontSize(value: number): boolean;
  json(): unknown;
  saved(): PatentBookDocument;
  text(): string;
  undo(): boolean;
  redo(): boolean;
  all(): boolean;
  paste(html: string, text: string): TypographyLine[];
  keyword(enabled: boolean): void;
  clipboard(): { text: string; html: string };
  history(): { undo: number; redo: number };
};

declare global {
  interface Window {
    typography: TypographyHarness;
  }
}

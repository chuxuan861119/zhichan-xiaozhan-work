import { Extension } from "@tiptap/core";
import { z } from "zod";
import {
  defaultDocumentFont,
  defaultDocumentFontSizePt,
  displayDocumentFont,
} from "../../../../shared/document/font-policy";
import { lineSpacingToCssLineHeight } from "../../../../shared/document/line-spacing";
import { SemanticRoleSchema } from "../../../../shared/document/model";

const FigureIdSchema = z.string().uuid();

function boundedNumber(
  element: HTMLElement,
  attributeName: string,
  minimum: number,
  maximum: number,
  fallback: number | null,
): number | null {
  const raw = element.getAttribute(attributeName);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function boundedNumberFromAttributeOrStyle(
  element: HTMLElement,
  attributeName: string,
  styleValue: string,
  minimum: number,
  maximum: number,
  fallback: number | null,
): number | null {
  const attribute = element.getAttribute(attributeName);
  const raw = attribute ?? styleValue;
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

export const PatentTextAttributes = Extension.create({
  name: "patentTextAttributes",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSizePt: {
            default: null,
            parseHTML: (element) =>
              boundedNumberFromAttributeOrStyle(
                element,
                "data-font-size-pt",
                element.style.fontSize,
                Number.MIN_VALUE,
                200,
                null,
              ),
            renderHTML: (attributes) =>
              typeof attributes.fontSizePt === "number" &&
              attributes.fontSizePt > 0 &&
              attributes.fontSizePt <= 200
                ? {
                    "data-font-size-pt": String(attributes.fontSizePt),
                    style: `font-size: ${attributes.fontSizePt}pt`,
                  }
                : {},
          },
        },
      },
      {
        types: ["paragraph", "heading"],
        attributes: {
          ...Object.fromEntries(
            (["Before", "After"] as const).map((side) => [
              `space${side}Pt`,
              {
                default: null,
                parseHTML: (element: HTMLElement) =>
                  boundedNumber(element, `data-space-${side.toLowerCase()}-pt`, 0, 200, null),
                renderHTML: (attributes: Record<string, unknown>) =>
                  attributes[`space${side}Pt`] == null
                    ? {}
                    : {
                        [`data-space-${side.toLowerCase()}-pt`]: String(
                          attributes[`space${side}Pt`],
                        ),
                        style: `margin-${side === "Before" ? "top" : "bottom"}: ${attributes[`space${side}Pt`]}pt`,
                      },
              },
            ]),
          ),
          lineHeight: {
            default: 1.5,
            parseHTML: (element) => boundedNumber(element, "data-line-height", 1, 3, 1.5),
            renderHTML: (attributes) => ({
              "data-line-height": String(attributes.lineHeight),
              // A ratio lets mixed-size runs grow naturally, as in the print renderer.
              style: `line-height: ${lineSpacingToCssLineHeight(attributes.lineHeight)}`,
            }),
          },
          paragraphIndentMm: {
            default: 0,
            parseHTML: (element) =>
              boundedNumberFromAttributeOrStyle(
                element,
                "data-paragraph-indent-mm",
                element.style.textIndent,
                0,
                80,
                0,
              ),
            renderHTML: (attributes) => ({
              "data-paragraph-indent-mm": String(attributes.paragraphIndentMm),
              style: `text-indent: ${attributes.paragraphIndentMm}mm`,
            }),
          },
          semanticRole: {
            default: null,
            parseHTML: (element) => {
              const parsed = SemanticRoleSchema.safeParse(
                element.getAttribute("data-semantic-role"),
              );
              return parsed.success ? parsed.data : null;
            },
            renderHTML: (attributes) =>
              SemanticRoleSchema.safeParse(attributes.semanticRole).success
                ? { "data-semantic-role": attributes.semanticRole }
                : {},
          },
          figureId: {
            default: null,
            parseHTML: (element) => {
              const parsed = FigureIdSchema.safeParse(element.getAttribute("data-figure-id"));
              return parsed.success ? parsed.data : null;
            },
            renderHTML: (attributes) =>
              FigureIdSchema.safeParse(attributes.figureId).success
                ? { "data-figure-id": attributes.figureId }
                : {},
          },
          defaultFontFamily: {
            default: defaultDocumentFont(),
            parseHTML: (element) =>
              element.getAttribute("data-default-font-family")?.slice(0, 100) ||
              defaultDocumentFont(),
            renderHTML: (attributes) => ({
              "data-default-font-family": attributes.defaultFontFamily,
              style: `font-family: "${displayDocumentFont(attributes.defaultFontFamily)}", serif`,
            }),
          },
          defaultFontSizePt: {
            default: defaultDocumentFontSizePt(),
            parseHTML: (element) =>
              boundedNumber(
                element,
                "data-default-font-size-pt",
                Number.MIN_VALUE,
                200,
                defaultDocumentFontSizePt(),
              ),
            renderHTML: (attributes) => ({
              "data-default-font-size-pt": String(attributes.defaultFontSizePt),
              style: `font-size: ${attributes.defaultFontSizePt}pt`,
            }),
          },
        },
      },
    ];
  },
});

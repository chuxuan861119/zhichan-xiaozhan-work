import {
  PATENT_TEMPLATE_NAME_MAX_LENGTH,
  PatentTemplateCatalogSchema,
  PatentTemplateSelectionSchema,
  PatentTemplateSlotSchema,
} from "./template-catalog.js";
import { createFactoryPatentTemplates } from "./templates.js";

const templates = createFactoryPatentTemplates(() => crypto.randomUUID());

function slot(overrides: Record<string, unknown> = {}) {
  return {
    templateId: crypto.randomUUID(),
    patentType: "invention",
    slotIndex: 1,
    name: "自定义模板 1",
    claims: null,
    description: null,
    abstract: null,
    revision: 0,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

test("accepts blank, system and custom template selections", () => {
  expect(PatentTemplateSelectionSchema.parse({ kind: "blank" })).toEqual({ kind: "blank" });
  expect(PatentTemplateSelectionSchema.parse({ kind: "system" })).toEqual({ kind: "system" });
  const templateId = crypto.randomUUID();
  expect(PatentTemplateSelectionSchema.parse({ kind: "custom", templateId })).toEqual({
    kind: "custom",
    templateId,
  });
  expect(
    PatentTemplateSelectionSchema.safeParse({ kind: "custom", templateId: null }).success,
  ).toBe(false);
});

test("requires a custom slot to contain either all three books or none", () => {
  expect(PatentTemplateSlotSchema.safeParse(slot()).success).toBe(true);
  expect(
    PatentTemplateSlotSchema.safeParse(
      slot({
        claims: templates.invention.claims,
        description: templates.invention.description,
        abstract: templates.invention.abstract,
      }),
    ).success,
  ).toBe(true);
  expect(
    PatentTemplateSlotSchema.safeParse(
      slot({
        claims: templates.invention.claims,
        description: null,
        abstract: templates.invention.abstract,
      }),
    ).success,
  ).toBe(false);
});

test("bounds template names without requiring uniqueness", () => {
  expect(PATENT_TEMPLATE_NAME_MAX_LENGTH).toBe(30);
  expect(PatentTemplateSlotSchema.safeParse(slot({ name: "甲".repeat(30) })).success).toBe(true);
  expect(PatentTemplateSlotSchema.safeParse(slot({ name: "甲".repeat(31) })).success).toBe(false);
  expect(PatentTemplateSlotSchema.safeParse(slot({ name: "   " })).success).toBe(false);
});

test("requires exactly three stable slots for each patent type", () => {
  const at = "2026-08-28T00:00:00.000Z";
  const catalog = {
    revision: 0,
    invention: {
      selection: { kind: "system" },
      slots: [1, 2, 3].map((slotIndex) =>
        slot({ templateId: crypto.randomUUID(), slotIndex, createdAt: at, updatedAt: at }),
      ),
    },
    "utility-model": {
      selection: { kind: "blank" },
      slots: [1, 2, 3].map((slotIndex) =>
        slot({
          templateId: crypto.randomUUID(),
          patentType: "utility-model",
          slotIndex,
          createdAt: at,
          updatedAt: at,
        }),
      ),
    },
  };

  expect(PatentTemplateCatalogSchema.safeParse(catalog).success).toBe(true);
  expect(
    PatentTemplateCatalogSchema.safeParse({
      ...catalog,
      invention: { ...catalog.invention, slots: catalog.invention.slots.slice(0, 2) },
    }).success,
  ).toBe(false);
  expect(
    PatentTemplateCatalogSchema.safeParse({
      ...catalog,
      invention: {
        ...catalog.invention,
        slots: [catalog.invention.slots[0], catalog.invention.slots[0], catalog.invention.slots[2]],
      },
    }).success,
  ).toBe(false);
});

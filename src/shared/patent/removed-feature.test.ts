import { createBlankPatent } from "./defaults.js";
import { migrateCanonicalPatent } from "./migrations.js";

describe("patents after chart removal", () => {
  test("new patents do not contain chart projects", () => {
    expect(createBlankPatent({ patentType: "invention", name: "普通专利" })).not.toHaveProperty(
      "scientificChartProjects",
    );
  });

  test("ignores retired project payloads without changing ordinary patent content or the input", () => {
    const patent = createBlankPatent({ patentType: "invention", name: "旧专利" });
    const legacy = { ...patent, scientificChartProjects: { damaged: true } };
    const before = structuredClone(legacy);
    const result = migrateCanonicalPatent(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).not.toHaveProperty("scientificChartProjects");
    expect(result.value.books).toEqual(patent.books);
    expect(result.value.name).toBe(patent.name);
    expect(legacy).toEqual(before);
  });
});

import { patentDisplayName } from "./display-name.js";

test("displays the local creation time for an unnamed patent", () => {
  const patent = {
    name: null,
    patentId: "00000000-0000-4000-8000-26b9c56a1f64",
    createdAt: new Date(2026, 8, 6, 1, 28).toISOString(),
  };
  expect(patentDisplayName(patent)).toBe("未命名专利 202609060128");
  expect(patent.name).toBeNull();
  expect(patentDisplayName({ ...patent, name: "防护壳" })).toBe("防护壳");
});

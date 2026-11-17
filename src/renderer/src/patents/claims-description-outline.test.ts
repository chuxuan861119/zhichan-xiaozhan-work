import { claimsDescriptionOutline } from "./claims-description-outline";

test("draws a single closed outline with a tangent inner curve", () => {
  const path = claimsDescriptionOutline(300, 160, 48, 154);
  expect(path).toContain("H 142.5 Q 154.5 48.5 154.5 36.5");
  expect(path.match(/M /gu)).toHaveLength(1);
  expect(path.endsWith("Z")).toBe(true);
});

test("uses a simple rounded outline when the toggle spans the full width", () => {
  const path = claimsDescriptionOutline(220, 180, 48, 0);
  expect(path).not.toContain("48.5");
  expect(path.endsWith("Z")).toBe(true);
});

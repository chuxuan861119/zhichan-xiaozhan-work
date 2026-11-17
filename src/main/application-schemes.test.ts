const register = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ protocol: { registerSchemesAsPrivileged: register } }));

import { registerApplicationSchemes } from "./application-schemes.js";

test("registers all schemes together so later registrations cannot erase earlier privileges", () => {
  registerApplicationSchemes();
  expect(register).toHaveBeenCalledTimes(1);
  const schemes = register.mock.calls[0]?.[0];
  expect(schemes.map((item: { scheme: string }) => item.scheme)).toEqual([
    "patent-print",
    "patent-app",
    "patent-diagram",
    "patent-ipc",
  ]);
  for (const scheme of schemes) expect(scheme.privileges.secure).toBe(true);
  expect(
    schemes.find((item: { scheme: string }) => item.scheme === "patent-app").privileges,
  ).toMatchObject({ supportFetchAPI: true, corsEnabled: true });
});

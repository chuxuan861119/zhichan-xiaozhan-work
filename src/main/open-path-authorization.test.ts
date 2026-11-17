import { OpenPathAuthorization } from "./open-path-authorization.js";

test("consumes each normalized command-line path authorization exactly once", () => {
  const authorization = new OpenPathAuthorization();
  authorization.authorize("C:\\Patents\\Draft.PATDOC");

  expect(authorization.consume("c:\\patents\\draft.patdoc")).toBe(true);
  expect(authorization.consume("C:\\Patents\\Draft.PATDOC")).toBe(false);
});

test("can revoke an authorization when dispatching to the renderer fails", () => {
  const authorization = new OpenPathAuthorization();
  authorization.authorize("C:\\Patents\\Draft.patdoc");
  authorization.revoke("C:\\Patents\\Draft.patdoc");

  expect(authorization.consume("C:\\Patents\\Draft.patdoc")).toBe(false);
});

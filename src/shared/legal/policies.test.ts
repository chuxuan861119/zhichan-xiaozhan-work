import { expect, test } from "vitest";
import type { AgreementState } from "./model.js";
import { legalSections } from "./policies.js";

test("open-source terms preserve GPL commercial rights without enterprise restrictions", () => {
  const state: AgreementState = {
    appVersion: "1.1.1",
    policy: {
      termsVersion: "test",
      privacyVersion: "test",
      operator: "发布测试主体",
      contact: "support@example.com",
    },
    needsConfirmation: true,
    reason: "first-use",
    showStatistics: true,
    statistics: null,
  };
  const text = legalSections("terms", state)
    .flatMap((s) => s.paragraphs)
    .join("\n");
  expect(text).toContain("GPL-3.0");
  expect(text).toContain("个人与企业");
  expect(text).toContain("对应源码");
  expect(text).not.toContain("员工代表单位使用，需另行取得授权");
  expect(text).not.toContain("代表您接受软件使用协议");
  expect(text).toContain("发布测试主体");
});

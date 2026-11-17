import { expect, test } from "./helpers/workbench.js";

test("launches with an isolated LOCALAPPDATA so recovery journals are never reused", async ({
  workbench,
}) => {
  const application = await workbench.launch();
  try {
    const localAppData = await application.evaluate(() => process.env.LOCALAPPDATA ?? "");
    // 应用数据根与数据导入恢复 journal 位于 LOCALAPPDATA 下；每次测试必须指向
    // 本测试的全新隔离目录，绝不读取/复用真实环境或其他实例的旧 journal。
    expect(localAppData.startsWith(workbench.root)).toBe(true);
    expect(localAppData).toContain("local-app-data");
  } finally {
    await application.close();
  }
});

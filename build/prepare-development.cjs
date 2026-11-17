const { join } = require("node:path");

exports.prepareDevelopment = async (root) => {
  const { auditDrawingRuntime } = await import("../scripts/audit-drawing-converter.mjs");
  const { auditCadcraftRuntime } = await import("../scripts/audit-cadcraft-runtime.mjs");
  try {
    await auditDrawingRuntime(join(root, "resources/drawing-converter"));
  } catch (error) {
    throw new Error(
      "开发实例的离线 CAD 组件缺失或校验失败。请按 tools/drawing-converter/README.md 准备当前工作树的 resources/drawing-converter 后重新启动。",
      { cause: error },
    );
  }
  try {
    await auditCadcraftRuntime(join(root, "resources/cadcraft"));
  } catch (error) {
    throw new Error(
      "开发实例的 CAD 编辑组件缺失或校验失败。请运行 npm run vendor:cad 准备当前平台的转换程序和浏览器编辑组件后重新启动。",
      { cause: error },
    );
  }
  if (process.platform === "darwin") {
    const { auditMacTools } = await import("../scripts/audit-mac-tools.mjs");
    try {
      await auditMacTools(root);
    } catch (error) {
      throw new Error(
        "开发实例的 Mac 文件迁移组件缺失或过期。请运行 npm run vendor:mac-tools 后重新启动。",
        { cause: error },
      );
    }
  }
};

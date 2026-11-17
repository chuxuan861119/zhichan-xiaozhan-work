import { APPLICATION_VERSION } from "./branding.js";

export type ApplicationBuildInfo = Readonly<{
  version: string;
  buildId: string;
  builtAt: string | null;
  commit: string | null;
  dirty: boolean | null;
  mode: "development" | "production";
}>;

declare const __APPLICATION_BUILD_INFO__: ApplicationBuildInfo;

export const APPLICATION_BUILD_INFO: ApplicationBuildInfo =
  typeof __APPLICATION_BUILD_INFO__ === "undefined"
    ? {
        version: APPLICATION_VERSION,
        buildId: "未记录",
        builtAt: null,
        commit: null,
        dirty: null,
        mode: "development",
      }
    : __APPLICATION_BUILD_INFO__;

export const APPLICATION_DIAGNOSTIC_VERSION = `${APPLICATION_VERSION} (${APPLICATION_BUILD_INFO.buildId})`;

export const APPLICATION_PRIVACY_SUMMARY =
  "参与使用统计默认开启；首次确认统计告知且服务开放后，仅发送每日粗粒度活跃贡献与前台时长区间次数，不发送专利内容或设备标识，可在“数据与安全 → 使用统计”中关闭。自动检查更新默认开启，仅向发布服务获取版本信息，不发送专利内容或客户信息；可在设置的“软件更新”中关闭。编辑、保存、本地检查、导出和打印可离线使用。主动使用 AI 纠错、润色或模型连接功能时，相关文字、上下文或验证信息会从您的设备直接发送至自行配置的 DeepSeek 官方接口。可在“AI 使用与隐私”中关闭连接。";

import channel from "../../../resources/update-channel.json" with { type: "json" };
import type { UpdateConfig } from "./update-service.js";

/** Isolated development tests may only use a local TLS server, never a remote override. */
export function softwareUpdateConfig(isPackaged: boolean): UpdateConfig {
  if (
    !isPackaged &&
    process.env.PATENT_WORKBENCH_TEST === "1" &&
    process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED
  ) {
    const url = new URL(process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED);
    if (
      url.protocol !== "https:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid isolated update feed");
    return { feedUrl: url.href, downloadOrigins: [url.origin] };
  }
  return isPackaged
    ? {
        feedUrl: channel.feedUrl,
        downloadOrigins: [...channel.downloadOrigins],
        channel: channel.channel === "preview" ? "preview" : "stable",
      }
    : { feedUrl: "", downloadOrigins: [] };
}
export function softwareUpdateTestMode(isPackaged: boolean) {
  return (
    !isPackaged &&
    process.env.PATENT_WORKBENCH_TEST === "1" &&
    Boolean(process.env.PATENT_WORKBENCH_UPDATE_TEST_FEED)
  );
}

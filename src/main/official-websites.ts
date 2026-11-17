import { shell } from "electron";
import { APPLICATION_WEBSITE } from "../shared/branding.js";
import { OFFICIAL_WEBSITES, OfficialWebsiteIdSchema } from "../shared/official-websites.js";

export async function openOfficialWebsite(input: unknown): Promise<void> {
  const id = OfficialWebsiteIdSchema.parse(input);
  const url =
    id === "work-home"
      ? APPLICATION_WEBSITE
      : id === "work-open-source"
        ? new URL("open-source/", APPLICATION_WEBSITE).href
        : OFFICIAL_WEBSITES.find((site) => site.id === id)?.url;
  if (!url) throw new Error("Unknown official website");
  await shell.openExternal(url);
}

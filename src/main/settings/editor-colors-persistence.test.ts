import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITOR_COLOR_PRESETS } from "../../shared/settings/editor-colors.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings/model.js";
import { SettingsService } from "./settings-service.js";

test("palette persists across restart, invalid updates preserve existing settings and legacy files load", async () => {
  const folder = await mkdtemp(join(tmpdir(), "editor-colors-test-"));
  try {
    const path = join(folder, "settings.json");
    const { editorColors: _colors, ...legacy } = DEFAULT_APP_SETTINGS;
    await writeFile(path, JSON.stringify(legacy));
    const service = new SettingsService(path);
    expect((await service.read()).editorColors).toEqual(DEFAULT_APP_SETTINGS.editorColors);
    const editorColors = EDITOR_COLOR_PRESETS[1]!.colors;
    await service.update({ editorColors });
    await service.update({ zoomPercent: 125 });
    expect((await new SettingsService(path).read()).editorColors).toEqual(editorColors);
    await expect(
      service.update({ editorColors: { ...editorColors, page: "#000000" } }),
    ).rejects.toThrow();
    expect((await new SettingsService(path).read()).editorColors).toEqual(editorColors);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

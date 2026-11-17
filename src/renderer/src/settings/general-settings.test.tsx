import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings/model";
import { confirmAppAction } from "../shared/app-dialog";
import { GeneralSettings, StorageOverview } from "./general-settings";

vi.mock("../shared/app-dialog", () => ({ confirmAppAction: vi.fn(async () => true) }));

test("display defaults only update display preferences after confirmation", async () => {
  const save = vi.fn(async () => true);
  render(
    <GeneralSettings kind="display" preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />,
  );
  fireEvent.click(screen.getByText("恢复显示默认设置"));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      uiScalePercent: 100,
      reducedMotion: false,
      editorColors: DEFAULT_APP_SETTINGS.editorColors,
      dualColumnFlow: { style: "graphite", mode: "boxes", margin: "dust" },
    }),
  );
  expect(confirmAppAction).toHaveBeenCalled();
});

test("dual column settings save style independently of display mode", async () => {
  const save = vi.fn(async () => true);
  render(
    <GeneralSettings kind="display" preferences={DEFAULT_APP_SETTINGS} onSavePreferences={save} />,
  );
  expect(screen.getByText("双列效果").closest("details")).toHaveProperty("open", false);
  fireEvent.click(screen.getByText("双列效果"));
  expect(screen.getByLabelText("传送盒风格")).toHaveProperty("value", "graphite");
  expect(screen.getByLabelText("双列衔接效果")).toHaveProperty("value", "boxes");
  fireEvent.change(screen.getByLabelText("传送盒风格"), { target: { value: "graphite" } });
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      dualColumnFlow: { style: "graphite", mode: "boxes", margin: "dust" },
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("双列衔接效果")).toHaveProperty("disabled", false),
  );
  fireEvent.change(screen.getByLabelText("双列衔接效果"), { target: { value: "off" } });
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      dualColumnFlow: { style: "graphite", mode: "off", margin: "dust" },
    }),
  );
});

test("AI switch reports a failed save and does not visually enable it", async () => {
  render(
    <GeneralSettings
      kind="ai-connections"
      preferences={{ ...DEFAULT_APP_SETTINGS, aiConnectionsEnabled: false }}
      onSavePreferences={async () => false}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  await screen.findByText(/保存失败，原设置未改变/u);
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
});

test("storage overview displays partial results and handles folder-open failure", async () => {
  const open = vi.fn(async () => ({ ok: false, error: { message: "无法打开目录" } }));
  Object.defineProperty(window, "patentApi", {
    configurable: true,
    value: {
      application: {
        storageOverview: async () => ({
          ok: true,
          value: {
            library: { path: "D:/测试文档库", bytes: 1024, partial: true },
            backup: { path: null, bytes: null, partial: false },
          },
        }),
        openStorageFolder: open,
        relocateLibrary: vi.fn(async () => ({ ok: true, value: false })),
      },
    },
  });
  render(<StorageOverview />);
  await screen.findByText("D:/测试文档库");
  expect(screen.getByText(/部分目录不可读/u)).toBeDefined();
  fireEvent.click(screen.getAllByText("打开文件夹")[0] as HTMLElement);
  await screen.findByRole("alert");
  expect(open).toHaveBeenCalledWith("library");
  fireEvent.click(screen.getByRole("button", { name: "迁移文档库" }));
  await waitFor(() => expect(window.patentApi.application.relocateLibrary).toHaveBeenCalledOnce());
});

test.each(["success", "cancel-picker", "cancel-confirm", "failure"])(
  "storage overview migrates backups through the existing service: %s",
  async (scenario) => {
    let folder = "C:/backups";
    const overview = vi.fn(async () => ({
      ok: true,
      value: {
        library: { path: "C:/library", bytes: 0, partial: false },
        backup: { path: folder, bytes: 0, partial: false },
      },
    }));
    const configure = vi.fn(async () => {
      if (scenario === "failure")
        return {
          ok: false,
          error: { message: "目标目录不可写", nextAction: "请重新选择并授权备份文件夹。" },
        };
      folder = "D:/backups";
      return { ok: true, value: { migratedCount: 2, skippedCount: 1, retainedSourceCount: 1 } };
    });
    vi.mocked(confirmAppAction).mockResolvedValue(scenario !== "cancel-confirm");
    Object.defineProperty(window, "patentApi", {
      configurable: true,
      value: {
        application: { storageOverview: overview },
        settings: {
          read: async () => ({
            ok: true,
            value: {
              backup: {
                enabled: false,
                folder: "C:/backups",
                intervalMinutes: 15,
              },
            },
          }),
        },
        backup: {
          selectFolder: async () => ({
            ok: true,
            value: scenario === "cancel-picker" ? null : "D:/backups",
          }),
          configure,
        },
      },
    });
    render(<StorageOverview />);
    fireEvent.click(await screen.findByRole("button", { name: "迁移定时备份" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "迁移定时备份" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    if (scenario.startsWith("cancel")) {
      expect(configure).not.toHaveBeenCalled();
      expect(screen.getByText("C:/backups")).toBeDefined();
    } else {
      expect(configure).toHaveBeenCalledWith({
        enabled: false,
        folder: "D:/backups",
        intervalMinutes: 15,
        migrateExisting: true,
        expectedSourceFolder: "C:/backups",
      });
      if (scenario === "failure") {
        expect(screen.getByRole("alert").textContent).toContain("目标目录不可写");
        expect(screen.getByRole("alert").textContent).toContain("请重新选择并授权备份文件夹。");
        expect(screen.getByText("C:/backups")).toBeDefined();
      } else {
        expect(screen.getByText("D:/backups")).toBeDefined();
        expect(screen.getByRole("status").textContent).toContain("已迁移 2 个备份");
        expect(screen.getByRole("status").textContent).toContain("1 个");
      }
    }
  },
);

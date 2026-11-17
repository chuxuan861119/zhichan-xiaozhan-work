import {
  createStartupService,
  isStartupIsolated,
  STARTUP_TRAY_ARGUMENT,
} from "./startup-service.js";

test("Harmony appspawn sandbox arguments do not disable installed startup management", async () => {
  for (const platform of ["openharmony", "ohos"]) {
    for (const argv of [
      ["/system/bin/appspawn", "--user-data-dir=/data/storage/el2/base/files/"],
      ["appspawn", "--user-data-dir", "/data/storage/el2/base/files"],
    ]) {
      expect(isStartupIsolated(platform, argv, {})).toBe(false);
      const service = createStartupService(
        { isPackaged: false } as never,
        platform,
        "appspawn",
        isStartupIsolated(platform, argv, {}),
        {
          readStartup: async () => true,
          openStartupSettings: async () => undefined,
        },
      );
      expect(await service.read()).toEqual({
        supported: true,
        enabled: true,
        management: "system",
      });
    }
  }
});

test("explicit test isolation and custom directories remain protected on every platform", () => {
  for (const platform of ["openharmony", "ohos", "darwin", "win32"]) {
    for (const argv of [
      ["--user-data-dir=/tmp/test"],
      ["--user-data-dir"],
      ["--user-data-dir=/data/storage/el2/base/files-test"],
    ]) {
      expect(isStartupIsolated(platform, argv, {})).toBe(true);
    }
    for (const environment of [
      { PATENT_WORKBENCH_TEST: "1" },
      { PATENT_WORKBENCH_ALLOW_MULTIPLE_INSTANCES: "1" },
      { PATENT_WORKBENCH_LIBRARY_ROOT: "/test" },
      { ZHICHAN_XIAOZHAN_WORK_LIBRARY_ROOT: "/test" },
    ]) {
      expect(
        isStartupIsolated(platform, ["--user-data-dir=/data/storage/el2/base/files/"], environment),
      ).toBe(true);
    }
  }
  expect(isStartupIsolated("darwin", ["--user-data-dir=/data/storage/el2/base/files/"], {})).toBe(
    true,
  );
});

test("Harmony installation delegates startup changes to the system rather than claiming to toggle them", async () => {
  const application = {
    isPackaged: false,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  };
  const native = {
    readStartup: vi.fn().mockResolvedValue(false),
    openStartupSettings: vi.fn().mockResolvedValue(undefined),
  };
  const service = createStartupService(
    application as never,
    "openharmony",
    "/bundle/app",
    false,
    native,
  );
  expect(await service.read()).toEqual({ supported: true, enabled: false, management: "system" });
  expect(await service.update(true)).toEqual({
    supported: true,
    enabled: false,
    management: "system",
  });
  expect(native.openStartupSettings).toHaveBeenCalledOnce();
  expect(application.setLoginItemSettings).not.toHaveBeenCalled();
  const isolated = createStartupService(
    application as never,
    "openharmony",
    "/bundle/app",
    true,
    native,
  );
  expect(await isolated.read()).toMatchObject({
    supported: false,
    enabled: false,
    unavailableReason: "测试实例不修改系统启动设置",
  });
  expect(() => isolated.update(true)).toThrow("临时实例");
});

test("isolated packaged copies cannot register themselves for login", async () => {
  const application = {
    isPackaged: true,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  };
  const service = createStartupService(application as never, "win32", "C:\\test.exe", true);
  expect((await service.read()).supported).toBe(false);
  expect(() => service.update(true)).toThrow("临时实例");
  expect(application.setLoginItemSettings).not.toHaveBeenCalled();
});

test("never writes Windows login items for development instances", async () => {
  const application = {
    isPackaged: false,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  };
  const service = createStartupService(application as never, "win32", "C:\\test.exe");
  expect(service.read()).toEqual({ supported: false, enabled: false });
  expect(() => service.update(true)).toThrow("安装版");
  expect(application.setLoginItemSettings).not.toHaveBeenCalled();
});
test("uses the same fixed executable and arguments when writing and reading", async () => {
  const application = {
    isPackaged: true,
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
      launchItems: [
        {
          name: "ZhichanXiaozhanWork",
          path: "c:\\work\\APP.exe",
          args: [],
          scope: "user",
          enabled: true,
        },
      ],
    })),
    setLoginItemSettings: vi.fn(),
  };
  const service = createStartupService(application as never, "win32", "C:\\Work\\app.exe");
  expect((await service.update(true)).enabled).toBe(true);
  expect(application.setLoginItemSettings).toHaveBeenCalledWith({
    path: "C:\\Work\\app.exe",
    args: [STARTUP_TRAY_ARGUMENT],
    name: "ZhichanXiaozhanWork",
    openAtLogin: true,
    enabled: true,
  });
  expect(application.getLoginItemSettings).toHaveBeenCalledWith({
    path: "C:\\Work\\app.exe",
    args: [STARTUP_TRAY_ARGUMENT],
  });
  application.getLoginItemSettings.mockReturnValue({
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    launchItems: [],
  });
  expect((await service.read()).enabled).toBe(false);
  expect(() => service.update(true)).toThrow("Windows");
});

test("ignores unrelated, disabled and machine startup entries", async () => {
  const item = {
    name: "ZhichanXiaozhanWork",
    path: "C:\\Work\\app.exe",
    args: [] as string[],
    scope: "user",
    enabled: true,
  };
  for (const patch of [
    { name: "Other" },
    { path: "C:\\Old\\app.exe" },
    { scope: "machine" },
    { enabled: false },
  ]) {
    const application = {
      isPackaged: true,
      getLoginItemSettings: vi.fn(() => ({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [{ ...item, ...patch }],
      })),
      setLoginItemSettings: vi.fn(),
    };
    const service = createStartupService(application as never, "win32", item.path, false);
    expect((await service.read()).enabled).toBe(false);
    expect((await service.update(false)).enabled).toBe(false);
  }
});
test("Mac login items read their own state without Windows launchItems", async () => {
  let enabled = false;
  const application = {
    isPackaged: true,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled })),
    setLoginItemSettings: vi.fn((value: { openAtLogin: boolean }) => {
      enabled = value.openAtLogin;
    }),
  };
  const service = createStartupService(
    application as never,
    "darwin",
    "/Applications/Test.app/Contents/MacOS/Test",
    false,
  );
  expect(service.update(true)).toEqual({ supported: true, enabled: true });
  expect(application.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  expect((await service.update(false)).enabled).toBe(false);
  expect(
    (await createStartupService(application as never, "darwin", "unused", true).read()).supported,
  ).toBe(false);
});

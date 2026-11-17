import { readFile } from "node:fs/promises";

test("user guide covers the complete local editing, persistence, export, and uninstall flow", async () => {
  const guide = await readFile("docs/user-guide.md", "utf8");
  expect(guide).toContain("# 知产小栈Work 使用手册");
  for (const topic of [
    "五书、其他文档与同屏双显",
    "权利要求书不允许全文没有任何权项编号",
    "附图、附图说明与附图标记",
    "保存、快照与定时备份",
    "完整数据迁移",
    "PATDOC",
    "DOCX",
    "PDF",
    "本地资料与升级",
    "常见问题与安全建议",
    "%LOCALAPPDATA%\\ZhichanXiaozhanWork\\Library",
    "重新安装后会继续读取原专利库",
  ]) {
    expect(guide).toContain(topic);
  }
});

test("known limitations explicitly disclose every Task 15 release limitation", async () => {
  const limitations = await readFile("docs/known-limitations.md", "utf8");
  expect(limitations).toContain("# 知产小栈Work 0.1.0 已知限制");
  for (const limitation of [
    "DOCX 导入支持常见段落",
    "不生成 CNIPA XML",
    "分页可能不同",
    "复杂公式可能转换为图形",
    "未知发布者",
    "异常退出后会在下次启动显示恢复检查结果",
    "WPS",
    ".recovery",
    "不会自动清理",
    "累积占用磁盘空间",
  ]) {
    expect(limitations).toContain(limitation);
  }
});

test("release checklist separates generated automated evidence from manual release evidence", async () => {
  const checklist = await readFile("docs/release-checklist.md", "utf8");
  expect(checklist).toContain("# 专利工作台发布检查清单");
  expect(checklist).toContain("npm run release:evidence");
  expect(checklist).toContain("自动门禁");
  expect(checklist).toContain("人工发布矩阵");
  expect(checklist).toContain("Microsoft Word / WPS");
  expect(checklist).toContain("WPS");
  expect(checklist).toContain("不能由源码存在、测试名称或历史结果推断为通过");
});

test("installer smoke script verifies install, single instance, association, uninstall, and retention", async () => {
  const smoke = await readFile("tests/installer-smoke.ps1", "utf8");
  for (const evidence of [
    "Start menu shortcut",
    "file association",
    "single instance",
    "uninstaller",
    "user document retained",
    "internal library retained after uninstall",
    "reinstalled application reopens retained library",
  ]) {
    expect(smoke).toContain(evidence);
  }
  expect(smoke).toContain("Refusing to run over an existing Patent Workbench installation");
  expect(smoke).toContain('DisplayName -match "^知产小栈Work(?:\\s+\\d');
  expect(smoke).toContain("Start-Process -FilePath $documentPath");
  expect(smoke).toContain('"document.opened"');
  expect(smoke).toContain("desktop shortcut created by installer");
  expect(smoke).toContain("desktop shortcut removed");
  expect(smoke).toContain("ZhichanXiaozhanWork\\Library");
  expect(smoke).toContain("library.sqlite3");
  expect(smoke).not.toContain("key-envelope.bin");
});

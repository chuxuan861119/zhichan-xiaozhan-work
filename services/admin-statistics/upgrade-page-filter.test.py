import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade-page-filter.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def test_patch_preserves_existing_visitor_export_and_rejects_a_second_application(self):
        code = '''const fields = ["date", "requests", "pages", "cachedPages", "downloads", "estimatedVisitors",];
const title = ["日期", "网站请求", "页面请求", "缓存304页面", "安装包请求", "访客估算",];
const definitions = {pages: "HTML 页面 GET 的 200 与 304 请求次数"};
function columns() { return ["页面请求（200/304）", r[dimension], r[count], r.cachedPages]; }
function selectVisitorEstimate() { return "preserved"; }
'''
        patched = upgrade.patch_main(code, '新版公开页面口径')
        fields = json.loads(re.search(r'const fields = (\[.*?\]);', patched, re.S)[1])
        self.assertEqual(fields[1:6], ['requests', 'pageViews', 'pages', 'cachedPageViews', 'cachedPages'])
        self.assertEqual(fields[-1], 'estimatedVisitors')
        self.assertIn('function selectVisitorEstimate() { return "preserved"; }', patched)
        self.assertIn('r[dimension], r.pageViews ?? "", r[count], r.cachedPageViews ?? "",', patched)
        with self.assertRaises(AssertionError):
            upgrade.patch_main(patched, '新版公开页面口径')


if __name__ == '__main__':
    unittest.main()

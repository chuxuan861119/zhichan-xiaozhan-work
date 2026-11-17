"""Upgrade public-page filtering while preserving the deployed visitor/usage modules."""
import base64
import datetime
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request


def sha(data):
    return hashlib.sha256(data).hexdigest()


def patch_main(code, definition):
    def array(name, change):
        nonlocal code
        pattern = re.compile(r'(const ' + name + r' = )\[(.*?)\];', re.S)
        matches = list(pattern.finditer(code))
        assert len(matches) == 1, name
        match = matches[0]
        values = json.loads('[' + re.sub(r',\s*$', '', match[2]) + ']')
        change(values)
        code = code[:match.start()] + match[1] + json.dumps(values, ensure_ascii=False) + ';' + code[match.end():]

    def fields(values):
        assert 'pageViews' not in values and 'cachedPageViews' not in values
        values.insert(values.index('requests') + 1, 'pageViews')
        values.insert(values.index('pages') + 1, 'cachedPageViews')

    def titles(values):
        index = values.index('网站请求')
        assert values[index + 1] == '页面请求'
        values[index:index + 2] = ['内容与资源请求（诊断）', '页面浏览（排除已识别自动化）',
                                  '全部页面请求（诊断）', '浏览中缓存304']

    array('fields', fields)
    array('title', titles)
    pattern = re.compile(r'\bpages:\s*("(?:\\.|[^"\\])*")')
    matches = list(pattern.finditer(code))
    assert len(matches) == 1 and json.loads(matches[0][1]).startswith('HTML 页面 GET'), 'definition'
    match = matches[0]
    code = code[:match.start(1)] + json.dumps(definition, ensure_ascii=False) + code[match.end(1):]
    matches = []
    for token in re.finditer(r'"(?:\\.|[^"\\])*"', code):
        try:
            if json.loads(token[0]) == '页面请求（200/304）': matches.append(token)
        except json.JSONDecodeError:
            pass
    assert len(matches) == 1, 'dimension headers'
    match = matches[0]
    headers = ','.join(json.dumps(s, ensure_ascii=False) for s in
                       ['页面浏览（排除已识别自动化）', '全部页面请求（200/304，诊断）', '浏览中缓存304'])
    code = code[:match.start()] + headers + code[match.end():]
    code, count = re.subn(r'r\[dimension\],\s*r\[count\],',
                         'r[dimension], r.pageViews ?? "", r[count], r.cachedPageViews ?? "",', code)
    assert count == 1, 'dimension values'
    return code


def load_collector(path):
    spec = importlib.util.spec_from_file_location('collector_' + sha(str(path).encode())[:8], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_report(report):
    for field in ('pages', 'pageViews', 'cachedPages', 'cachedPageViews'):
        total = sum(d[field] for d in report['days'].values())
        for rows in (report['pages'], report['products'], report['hours']):
            key = 'count' if field == 'pages' and rows is report['pages'] else field
            assert sum(r[key] for r in rows) == total, field
    for row in report['days'].values():
        assert row['pages'] == row['automatedPages'] + row['unmarkedPages'] + row['unknownPages']
        assert row['pageViews'] == row['unmarkedPages'] + row['unknownPages']
        assert 0 <= row['cachedPageViews'] <= row['pageViews'] <= row['pages']
    assert all(r['path'] in {'/', '/work/', '/search/', '/ai/', '/manage/', '/docs/work/',
                             '/docs/work/agent-cli/', '/privacy/', '/terms/', '/contact/'}
               for r in report['pages'])


def run(*args):
    subprocess.run(args, check=True)


def switch(current, target):
    temporary = current.with_name('current.page-filter-next')
    assert not temporary.exists() and not temporary.is_symlink()
    temporary.symlink_to(target)
    os.replace(temporary, current)


def fetch(url):
    request = urllib.request.Request(url, headers={'X-Zcxzz-Check': 'deployment'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def main(bundle_path):
    assert os.geteuid() == 0
    os.umask(0o077)
    bundle = json.loads(gzip.decompress(Path(bundle_path).read_bytes()))
    base = Path('/opt/zcxzz-statistics')
    current = base / 'current'
    previous = current.resolve(strict=True)
    assert previous == base / 'releases' / bundle['baseRelease'], previous
    for name, digest in bundle['baseHashes'].items():
        assert sha((previous / name).read_bytes()) == digest, name
    code = patch_main((previous / 'main.mjs').read_text(), bundle['definition'])
    assert 'function selectVisitorEstimate' in code
    target = base / 'releases/20261026-public-page-filter-v1'
    backup = Path('/var/lib/zcxzz-log-recovery/20261026-public-page-filter')
    assert not target.exists() and not backup.exists()
    config_path = Path('/etc/zcxzz/statistics.json')
    config_bytes = config_path.read_bytes()
    config = json.loads(config_bytes)
    collector_config_path = Path('/etc/zcxzz/statistics-collector.json')
    collector_config_bytes = collector_config_path.read_bytes()
    collector_config = json.loads(collector_config_bytes)
    administrator = Path(config['privateDirectory']) / 'administrator.json'
    administrator_bytes = administrator.read_bytes()
    backup.mkdir(mode=0o700)
    run('systemctl', 'start', 'zcxzz-statistics-backup.service')
    shutil.copytree(previous, target)
    target.chmod(0o755)
    assert set(bundle['files']) == {'traffic.py', 'public/app.js'}
    for name, encoded in bundle['files'].items():
        assert name in ('traffic.py', 'public/app.js')
        path = target / name
        data = base64.b64decode(encoded)
        assert sha(data) == bundle['targetHashes'][name], name
        path.write_bytes(data)
        path.chmod(0o644)
    (target / 'main.mjs').write_text(code)
    node = '/opt/node-v24.22.0-linux-x64/bin/node'
    run(node, '--check', str(target / 'main.mjs'))
    run(node, '--check', str(target / 'public/app.js'))
    snapshot = backup / 'logs'
    snapshot.mkdir(mode=0o700)
    for path in Path(collector_config['logDirectory']).glob('access.jsonl*'):
        if path.is_file():
            shutil.copyfile(path, snapshot / path.name)
    paths = sorted(snapshot.glob('access.jsonl*'))
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
    before = load_collector(previous / 'traffic.py').summarize(paths, today)
    after = load_collector(target / 'traffic.py').summarize(paths, today)
    verify_report(after)
    for date, row in before['days'].items():
        replacement = after['days'].get(date, {})
        for field in ('downloads', 'fullResponses', 'rangeRequests', 'downloadBytes', 'downloadErrors'):
            assert row[field] == replacement.get(field, 0), (date, field)
    assert 'visitorEstimates' in after
    report_path = Path(config['trafficPath'])
    shutil.copyfile(report_path, backup / 'traffic.before.json')
    try:
        switch(current, target)
        run('systemctl', 'restart', 'zcxzz-statistics')
        for attempt in range(20):
            try:
                assert json.loads(fetch('http://127.0.0.1:8790/admin-statistics/api/session'))['setupRequired'] is False
                break
            except Exception:
                if attempt == 19: raise
                time.sleep(0.5)
        run('systemctl', 'start', 'zcxzz-statistics-collector.service')
        report = json.loads(report_path.read_bytes())
        assert report['schemaVersion'] == 3 and 'visitorEstimates' in report
        verify_report(report)
        assert config_path.read_bytes() == config_bytes
        assert collector_config_path.read_bytes() == collector_config_bytes
        assert administrator.read_bytes() == administrator_bytes
        assert sha(fetch('https://zcxzz.cn/admin-statistics/app.js')) == sha((target / 'public/app.js').read_bytes())
        try:
            fetch('https://zcxzz.cn/admin-statistics/api/report')
            raise AssertionError('unauthenticated report allowed')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        result = dict(release=str(target), schemaVersion=3, generatedAt=report['generatedAt'],
                      pageViews=sum(d['pageViews'] for d in report['days'].values()),
                      excludedTechnicalRequests=report['quality']['excludedTechnicalRequests'],
                      verified=['public-page whitelist', 'page/product/hour totals', 'visitor estimates preserved',
                                'download totals preserved on identical logs', 'account and configuration preserved',
                                'public asset digest and unauthenticated report denial'])
        (backup / 'published.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception:
        switch(current, previous)
        run('systemctl', 'restart', 'zcxzz-statistics')
        run('systemctl', 'start', 'zcxzz-statistics-collector.service')
        raise


if __name__ == '__main__':
    main(sys.argv[1])

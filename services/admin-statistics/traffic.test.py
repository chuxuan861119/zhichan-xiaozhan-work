import importlib.util
import tempfile
import unittest
import json
import gzip
from pathlib import Path

spec = importlib.util.spec_from_file_location('traffic', Path(__file__).with_name('traffic.py'))
traffic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(traffic)

class TrafficTests(unittest.TestCase):
    def test_only_public_pages_count_and_machine_checks_never_inflate_visits(self):
        base = dict(time='2026-10-17T12:00:00+08:00', method='GET', status=200, bytes=10, automated='0')
        paths = ['/', '/index.html', '/work/index.html?tab=1', '/search/',
                 '/updates/work/preview.json', '/updates/', '/api/', '/api/result.html',
                 '/v1/usage/daily-aggregate', '/admin-statistics/', '/healthz',
                 '/downloads/setup.exe.sha256', '/unknown.html', '/unknown/',
                 '/brand-layout-preview.html', '/404.html', '/assets/app.js']
        rows = [dict(base,path=path) for path in paths]
        rows += [dict(base,path='/work/',automated='1'),
                 dict(base,path='/docs/work/',status=304,bytes=0),
                 dict(base,path='/contact/',probe='1'),
                 dict(base,path='/downloads/setup.exe',status=206)]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'access.jsonl'
            p.write_text(''.join(json.dumps(r)+'\n' for r in rows),encoding='utf8')
            report=traffic.summarize([p], '2026-10-17')
            day=report['days']['2026-10-17']
            self.assertEqual(day['pageViews'],5)
            self.assertEqual(day['pages'],6)
            self.assertEqual(day['automatedPages'],1)
            self.assertEqual(day['cachedPageViews'],1)
            self.assertEqual(day['downloads'],1)
            self.assertEqual(report['quality']['excludedTechnicalRequests'],8)
            self.assertEqual(report['quality']['excludedRequests'],9)
            self.assertEqual({r['path'] for r in report['pages']},{'/', '/work/', '/search/', '/docs/work/'})
            for rows in (report['pages'],report['products'],report['hours']):
                self.assertEqual(sum(r['pageViews'] for r in rows),5)
            self.assertEqual(report,traffic.summarize([p], '2026-10-17'))

    def test_cached_pages_products_hours_and_automation_are_consistent(self):
        rows = [
            dict(time='2026-10-16T17:15:00Z', method='GET', path='/work/index.html?secret=x', status=304, bytes=0, automated='0'),
            dict(time='2026-10-17T01:45:00+08:00', method='GET', path='/scheme-three.html', status=200, bytes=10, automated='1'),
            dict(time='2026-10-17T02:10:00+08:00', method='GET', path='/docs/work/', status=200, bytes=10),
            dict(time='2026-10-17T02:20:00+08:00', method='GET', path='/search/', status=200, bytes=10, automated='0'),
            dict(time='2026-10-17T02:30:00+08:00', method='GET', path='/assets/app.js', status=304, bytes=0, automated='1'),
            dict(time='2026-10-17T02:35:00+08:00', method='GET', path='/missing/', status=404, bytes=10),
            dict(time='2026-10-17T02:40:00+08:00', method='HEAD', path='/ai/', status=200, bytes=0),
            dict(time='2026-10-17T02:45:00+08:00', method='GET', path='/manage/', status=200, bytes=10, probe='1'),
        ]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'access.jsonl'
            p.write_text(''.join(json.dumps(r)+'\n' for r in rows),encoding='utf8')
            data=traffic.summarize([p], '2026-10-17')
            day=data['days']['2026-10-17']
            self.assertEqual((day['pages'],day['cachedPages'],day['automatedPages'],day['unmarkedPages'],day['unknownPages']),(4,1,1,2,1))
            work=next(r for r in data['products'] if r['product']=='work')
            self.assertEqual(work['pages'],2)
            self.assertEqual(next(r for r in data['products'] if r['product']=='work-docs')['pages'],1)
            self.assertEqual(next(r for r in data['pages'] if r['path']=='/work/')['count'],2)
            self.assertEqual(sum(r['pages'] for r in data['hours']),4)
            self.assertEqual(sum(r['pages'] for r in data['products']),4)
            self.assertEqual(data['hours'][0]['hour'],'2026-10-17T01:00:00+08:00')
            self.assertNotIn('secret',json.dumps(data))
            self.assertEqual(data,traffic.summarize([p], '2026-10-17'))

    def test_metrics_and_missing_completion(self):
        rows = [
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/', status=200, bytes=100),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/downloads/setup.exe', status=200, bytes=500),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/downloads/setup.exe', status=206, bytes=500, completed='OK', length='500'),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/downloads/setup.exe', status=200, bytes=500, completed='OK', length='500'),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/downloads/setup.exe', status=200, bytes=250, completed='', length='500'),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/admin-statistics/api/report', status=401, bytes=20),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/missing', status=404, bytes=20),
            dict(time='2026-10-16T20:00:00+08:00', method='GET', path='/', status=200, bytes=20, ip='127.0.0.1'),
        ]
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'access.jsonl'; p.write_text(''.join(json.dumps(r)+'\n' for r in rows)+'{partial',encoding='utf8')
            result=traffic.summarize([p], '2026-10-17')
            day=result['days']['2026-10-16']
            self.assertEqual(day['pages'],1)
            self.assertEqual(day['downloads'],4)
            self.assertEqual(day['fullResponses'],1)
            self.assertEqual(day['rangeRequests'],1)
            self.assertEqual(day['legacyDownloads'],1)
            self.assertEqual(day['incompleteResponses'],1)
            self.assertEqual(day['errors'],1)
            self.assertEqual(day['requests'],6)
            self.assertEqual(result['quality']['excludedRequests'],2)
            self.assertEqual(result['quality']['invalidLines'],1)
            self.assertNotIn('ip',json.dumps(result))

    def test_timezone_compression_and_idempotence(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'access.jsonl.gz'
            with gzip.open(p,'wt',encoding='utf8') as f:
                f.write(json.dumps(dict(time='2026-10-16T17:00:00Z',method='GET',path='/search/?private=x',status=200,bytes=3))+'\n')
            a=traffic.summarize([p], '2026-10-17')
            self.assertEqual(a,traffic.summarize([p], '2026-10-17'))
            self.assertEqual(a['days']['2026-10-17']['pages'],1)
            self.assertEqual(a['pages'][0]['path'],'/search/')
            self.assertNotIn('private',json.dumps(a))

    def test_no_fabricated_zero_and_old_dates_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'access.jsonl'; p.write_text(json.dumps(dict(time='2020-01-01T00:00:00Z',method='GET',path='/',status=200,bytes=1))+'\n')
            self.assertEqual(traffic.summarize([p],'2026-10-17')['days'],{})

if __name__=='__main__': unittest.main()

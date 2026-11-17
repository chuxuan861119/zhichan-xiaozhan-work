#!/usr/bin/env python3
"""Rebuild a bounded, IP-free report. Re-reading logs never adds duplicate totals."""
import collections
import datetime
import gzip
import json
import os
from pathlib import Path
import sys

ZONE = datetime.timezone(datetime.timedelta(hours=8))
PAGE_FIELDS = ('pages','pageViews','cachedPages','cachedPageViews','automatedPages','unmarkedPages','unknownPages')
FIELDS = ('requests','downloads','rangeRequests','fullResponses','incompleteResponses','legacyDownloads','downloadErrors','errors','bytes','downloadBytes','automatedRequests') + PAGE_FIELDS
ALIASES = {
    '/scheme-three.html':'/work/', '/manual.html':'/docs/work/',
    '/agent-cli.html':'/docs/work/agent-cli/', '/privacy.html':'/privacy/',
    '/terms.html':'/terms/', '/contact.html':'/contact/',
}
PUBLIC_PAGES = frozenset(('/', '/work/', '/search/', '/ai/', '/manage/',
                          '/docs/work/', '/docs/work/agent-cli/', '/privacy/', '/terms/', '/contact/'))
TECHNICAL_PREFIXES = ('/admin-statistics', '/v1', '/api', '/updates', '/health', '/healthz', '/metrics', '/.well-known')

def technical_request(uri):
    return any(uri == p or uri.startswith(p + '/') for p in TECHNICAL_PREFIXES) or (uri.startswith('/downloads/') and uri.endswith('.sha256'))

def canonical_page(uri):
    uri = ALIASES.get(uri, uri)
    return uri[:-10] if uri.endswith('/index.html') else uri

def product_for(uri):
    if uri == '/': return 'brand'
    if uri.startswith('/docs/work/'): return 'work-docs'
    for name in ('work','search','ai','manage'):
        if uri.startswith('/'+name+'/'): return name
    if uri in ('/privacy/','/terms/','/contact/'): return 'support'
    return 'other'

def add_page(record, item):
    record['pages'] += 1
    record['cachedPages'] += int(int(item['status']) == 304)
    category = {'1':'automatedPages','0':'unmarkedPages'}.get(item.get('automated'), 'unknownPages')
    record[category] += 1
    if item.get('automated') != '1':
        record['pageViews'] += 1
        record['cachedPageViews'] += int(int(item['status']) == 304)

def summarize(paths, today):
    cutoff = (datetime.date.fromisoformat(today)-datetime.timedelta(days=189)).isoformat()
    days = collections.defaultdict(lambda:dict.fromkeys(FIELDS,0))
    pages = collections.defaultdict(lambda:dict.fromkeys(PAGE_FIELDS,0))
    products = collections.defaultdict(lambda:dict.fromkeys(PAGE_FIELDS,0))
    hours = collections.defaultdict(lambda:dict.fromkeys(PAGE_FIELDS,0))
    statuses = collections.Counter()
    downloads = {}
    quality = dict(invalidLines=0, excludedRequests=0, excludedTechnicalRequests=0, sourceFiles=0, enhancedSince=None, firstObserved=None, lastObserved=None)
    for path in paths:
        quality['sourceFiles'] += 1
        opener = gzip.open if path.suffix=='.gz' else open
        with opener(path,'rt',encoding='utf8',errors='replace') as stream:
            for line in stream:
                try:
                    item=json.loads(line)
                    stamp=datetime.datetime.fromisoformat(item['time'].replace('Z','+00:00'))
                    if stamp.tzinfo is None: raise ValueError('missing timezone')
                    stamp=stamp.astimezone(ZONE)
                    date=stamp.date().isoformat()
                    status=int(item['status']); size=int(item['bytes'])
                    uri=item['path'].split('?',1)[0]
                    if not uri.startswith('/') or len(uri)>2048 or status<100 or status>599 or size<0: raise ValueError('invalid')
                except (ValueError,KeyError,TypeError,AttributeError):
                    quality['invalidLines'] += 1
                    continue
                if date<cutoff or date>today: continue
                if technical_request(uri):
                    quality['excludedTechnicalRequests'] += 1
                    quality['excludedRequests'] += 1
                    continue
                if item.get('probe')=='1' or str(item.get('ip','')).startswith('127.') or item.get('ip')=='::1':
                    quality['excludedRequests'] += 1
                    continue
                iso=stamp.isoformat()
                quality['firstObserved']=min(quality['firstObserved'] or iso,iso)
                quality['lastObserved']=max(quality['lastObserved'] or iso,iso)
                if 'completed' in item: quality['enhancedSince']=min(quality['enhancedSince'] or iso,iso)
                day=days[date]; day['requests']+=1; day['bytes']+=size; day['errors']+=int(status>=400)
                day['automatedRequests']+=int(item.get('automated')=='1')
                statuses[(date,str(status))]+=1
                if item.get('method')=='GET' and status in (200,304) and canonical_page(uri) in PUBLIC_PAGES:
                    canonical=canonical_page(uri)
                    hour=stamp.replace(minute=0,second=0,microsecond=0).isoformat()
                    for record in (day,pages[(date,canonical)],products[(date,product_for(canonical))],hours[(date,hour)]):
                        add_page(record,item)
                if item.get('method')!='GET' or not(uri.startswith('/downloads/') and uri.endswith('.exe')): continue
                if status not in (200,206):
                    day['downloadErrors']+=int(status>=400)
                    continue
                day['downloads']+=1; day['downloadBytes']+=size
                record=downloads.setdefault((date,uri),dict.fromkeys(('requests','fullResponses','rangeRequests','bytes'),0))
                record['requests']+=1; record['bytes']+=size
                if status==206:
                    day['rangeRequests']+=1; record['rangeRequests']+=1
                elif 'completed' not in item:
                    day['legacyDownloads']+=1
                else:
                    try: length=int(item.get('length','-1'))
                    except (ValueError,TypeError): length=-1
                    if item.get('completed')=='OK' and length>0 and size==length:
                        day['fullResponses']+=1; record['fullResponses']+=1
                    else: day['incompleteResponses']+=1
    return dict(days=dict(sorted(days.items())),pages=[dict(day=d,path=p,count=v['pages'],**{k:n for k,n in v.items() if k!='pages'}) for (d,p),v in sorted(pages.items())],
                products=[dict(day=d,product=p,**v) for (d,p),v in sorted(products.items())],
                hours=[dict(day=d,hour=h,**v) for (d,h),v in sorted(hours.items())],
                statuses=[dict(day=d,status=s,count=n) for (d,s),n in sorted(statuses.items())],
                downloads=[dict(day=d,path=p,**v) for (d,p),v in sorted(downloads.items())],quality=quality)

def main():
    os.umask(0o027)
    config=json.loads(Path(sys.argv[1]).read_text())
    now=datetime.datetime.now(ZONE)
    # A single collector process, supervised by systemd, rebuilds from retained files.
    result=summarize(sorted(Path(config['logDirectory']).glob('access.jsonl*')),now.date().isoformat())
    result.update(schemaVersion=3,timezone='Asia/Shanghai',generatedAt=now.isoformat(),coverage='observed-public-pages')
    target=Path(config['trafficPath']); target.parent.mkdir(mode=0o750,parents=True,exist_ok=True)
    temp=target.with_suffix('.next')
    temp.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    os.chmod(temp,0o640); os.replace(temp,target)
    print('Traffic report refreshed; no client identifiers exported.')

if __name__=='__main__': main()

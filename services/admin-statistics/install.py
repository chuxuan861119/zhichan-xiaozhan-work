#!/usr/bin/env python3
"""One-time installation on the verified zcxzz host; refuse existing deployments."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile
import time
import urllib.request

RELEASE='20261017-statistics-v1'
NODE_VERSION='24.22.0'
NODE_SHA='cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008'
BASE=Path('/opt/zcxzz-statistics')
CONFIG=Path('/etc/zcxzz/statistics.json')
def run(*args): subprocess.run(args,check=True)
def write(path,content,mode=0o644):
    path=Path(path); assert not path.exists(),path
    path.write_text(content,encoding='utf8');path.chmod(mode)

def main():
    os.umask(0o027)
    assert os.geteuid()==0
    assert not CONFIG.exists() and not BASE.exists()
    conf=Path('/etc/zcxzz/nginx.conf'); original=conf.read_text()
    assert 'listen 443 ssl;' in original and '127.0.0.1:8443' in original
    assert '/admin-statistics' not in original
    try: pwd.getpwnam('zcxzzstats')
    except KeyError: run('useradd','--system','--home-dir','/var/lib/zcxzz-admin','--shell','/sbin/nologin','zcxzzstats')
    user=pwd.getpwnam('zcxzzstats')
    archive=Path('/root/node-v'+NODE_VERSION+'-linux-x64.tar.xz')
    if not archive.exists(): urllib.request.urlretrieve('https://nodejs.org/dist/v'+NODE_VERSION+'/'+archive.name,archive)
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==NODE_SHA
    runtime=Path('/opt/node-v'+NODE_VERSION+'-linux-x64')
    if not runtime.exists():
        with tarfile.open(archive) as t:
            assert all((Path('/opt')/m.name).resolve().is_relative_to(runtime) for m in t.getmembers())
            t.extractall('/opt')
    run(str(runtime/'bin/node'),'--version')
    bundle=Path('/root/zcxzz-statistics-v1.tar.gz')
    manifest=json.loads(Path('/root/zcxzz-statistics-v1-manifest.json').read_text())
    release=BASE/'releases'/RELEASE;release.mkdir(parents=True,mode=0o755)
    with tarfile.open(bundle) as t:
        assert all(not m.issym() and not m.islnk() and (release/m.name).resolve().is_relative_to(release) for m in t.getmembers())
        t.extractall(release)
    for entry in manifest:
        p=release/entry['path'];assert p.resolve().is_relative_to(release)
        assert hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256']
    for p in [BASE,BASE/'releases',release,*release.rglob('*')]:p.chmod(0o755 if p.is_dir() else 0o644)
    (BASE/'current').symlink_to(release)
    private=Path('/var/lib/zcxzz-admin');private.mkdir(mode=0o700,exist_ok=True);os.chown(private,user.pw_uid,user.pw_gid)
    config=json.loads((release/'config.example.json').read_text());write(CONFIG,json.dumps(config,indent=2)+'\n',0o640);os.chown(CONFIG,0,user.pw_gid)
    collector=dict(logDirectory='/var/log/zcxzz',trafficPath=config['trafficPath'])
    write('/etc/zcxzz/statistics-collector.json',json.dumps(collector)+'\n',0o640)
    write('/etc/systemd/system/zcxzz-statistics.service',f'''[Unit]
Description=Zcxzz private statistics console and usage receiver
After=network.target
[Service]
User=zcxzzstats
Group=zcxzzstats
UMask=0077
ExecStart={runtime}/bin/node {BASE}/current/main.mjs {CONFIG}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/zcxzz-admin
MemoryMax=256M
TasksMax=64
[Install]
WantedBy=multi-user.target
''')
    write('/etc/systemd/system/zcxzz-statistics-collector.service',f'''[Unit]
Description=Build Zcxzz IP-free website statistics
[Service]
Type=oneshot
UMask=0027
ExecStart=/usr/bin/python3 {BASE}/current/traffic.py /etc/zcxzz/statistics-collector.json
ExecStartPost=/usr/bin/chown root:zcxzzstats /var/lib/zcxzz-admin/traffic.json
NoNewPrivileges=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/zcxzz-admin
MemoryMax=192M
''')
    write('/etc/systemd/system/zcxzz-statistics-collector.timer','''[Unit]
Description=Refresh website statistics every five minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true
[Install]
WantedBy=timers.target
''')
    # The console can only read its IP-free copy, not the raw access logs.
    backup=Path('/etc/zcxzz/nginx.before-statistics-20261017.conf');write(backup,original,0o600)
    map_config='''    map $http_user_agent $stats_automated { default 0; ~*(bot|spider|crawler|curl|wget|python|UsageStatistics) 1; }
    map $http_x_zcxzz_check $stats_probe { default 0; "deployment" 1; }
    limit_req_zone $binary_remote_addr zone=zcxzz_login:1m rate=10r/m;
    limit_req_zone $binary_remote_addr zone=zcxzz_usage:2m rate=20r/m;
'''
    candidate=original.replace('http {','http {\n'+map_config,1)
    old_format='"bytes":$body_bytes_sent}'
    new_format='"bytes":$body_bytes_sent,"completed":"$request_completion","length":"$sent_http_content_length","automated":"$stats_automated","probe":"$stats_probe"}'
    assert old_format in candidate;candidate=candidate.replace(old_format,new_format,1)
    locations='''        location = /admin-statistics { return 302 /admin-statistics/; }
        location ^~ /admin-statistics/ {
            proxy_pass http://127.0.0.1:8790;
            proxy_set_header Host zcxzz.cn;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 15s;
            client_max_body_size 4k;
            client_body_buffer_size 8k;
            proxy_request_buffering off;
            add_header X-Robots-Tag "noindex, nofollow" always;
        }
        location = /admin-statistics/api/login {
            limit_req zone=zcxzz_login burst=5 nodelay;
            proxy_pass http://127.0.0.1:8790;
            proxy_set_header Host zcxzz.cn;
            proxy_set_header X-Real-IP $remote_addr;
            client_max_body_size 4k;
            client_body_buffer_size 8k;
            proxy_request_buffering off;
        }
        location = /v1/usage/daily-aggregate {
            limit_except POST { deny all; }
            limit_req zone=zcxzz_usage burst=5 nodelay;
            client_max_body_size 2k;
            client_body_buffer_size 8k;
            client_body_timeout 5s;
            proxy_request_buffering off;
            proxy_pass http://127.0.0.1:8789;
            proxy_read_timeout 10s;
            proxy_set_header Host zcxzz.cn;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header Cookie "";
            proxy_set_header Authorization "";
        }
'''
    candidate=candidate.replace('        location / { try_files $uri $uri/ =404; }',locations+'        location / { try_files $uri $uri/ =404; }',1)
    candidate_path=Path('/etc/zcxzz/nginx.statistics-ready.conf');write(candidate_path,candidate,0o600)
    run('nginx','-t','-c',str(candidate_path))
    run('systemctl','daemon-reload');run('systemctl','start','zcxzz-statistics-collector.service');run('systemctl','enable','--now','zcxzz-statistics.service','zcxzz-statistics-collector.timer')
    try:
        for attempt in range(15):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8790/admin-statistics/api/session',timeout=2) as r: assert json.load(r)['setupRequired']
                break
            except OSError:
                if attempt==14: raise
                time.sleep(1)
        pending=conf.with_suffix('.statistics-next');pending.write_text(candidate);pending.chmod(0o600);os.replace(pending,conf)
        run('systemctl','reload','zcxzz-web')
        print('STATISTICS_DEPLOYED: services active; admin setup required; receiver rejects all versions until release activation.',flush=True)
    except BaseException:
        restore=conf.with_suffix('.restore');restore.write_text(original);restore.chmod(0o600);os.replace(restore,conf);run('systemctl','reload','zcxzz-web');raise

if __name__=='__main__': main()

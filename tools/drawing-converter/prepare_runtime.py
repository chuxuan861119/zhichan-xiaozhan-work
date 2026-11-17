"""Build a target-specific offline runtime. Development only; never called by the app."""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from prepare_reader_source import prepare

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT.parent.parent / 'resources' / 'drawing-converter'

def configure_windows_python(py):
    # _pth replaces sys.path even for a script: permit only the bundled parent modules.
    (py / 'python313._pth').write_text('python313.zip\n.\n..\nLib/site-packages\nimport site\n', encoding='utf8')

def prepare_mac(output, target, dotnet, python):
    expected_machine = 'arm64' if target == 'osx-arm64' else 'x86_64'
    actual = subprocess.check_output([python, '-c', 'import platform; print(platform.machine())'], text=True).strip()
    if sys.platform != 'darwin' or actual != expected_machine:
        raise RuntimeError('Build the Mac renderer with a native Python of the target architecture.')
    subprocess.run([python, '-c', """
import importlib.metadata
import pathlib
import sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    name, expected = line.split('==')
    actual = importlib.metadata.version(name)
    if actual != expected:
        raise RuntimeError(f'{name}: expected {expected}, installed {actual}')
""", str(ROOT / 'requirements-macos.txt')], check=True)
    subprocess.run([dotnet, 'publish' , str(ROOT / 'reader/CadReader.csproj'), '-c', 'Release',
                    '-r', target, '--self-contained', 'true', '-o', str(output / 'reader')], check=True)
    reader_licenses(output, target)
    work = ROOT.parent.parent / 'out-drawing-runtime-cache' / (output.name + '-' + target + '-renderer')
    work.mkdir(parents=True)
    subprocess.run([python, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'render_svg',
                    '--target-arch', 'arm64' if target == 'osx-arm64' else 'x86_64',
                    '--distpath', str(work / 'dist'), '--workpath', str(work / 'work'),
                    '--specpath', str(work), '--collect-all', 'ezdxf',
                    '--collect-all', 'fontTools', str(ROOT / 'render_svg.py')], check=True)
    shutil.move(str(work / 'dist/render_svg'), str(output / 'renderer'))
    license_dir = output / 'licenses'
    license_dir.mkdir()
    subprocess.run([python, str(ROOT / 'collect_python_licenses.py'), str(license_dir)], check=True)
    shutil.copyfile(ROOT / 'render_svg.py', output / 'render_svg.py')
    shutil.copyfile(ROOT / 'tiled_svg.py', output / 'tiled_svg.py')
    finish_manifest(output, target, python)

def reader_licenses(output, target):
    reader = output / 'reader'
    licenses = reader / 'licenses'
    licenses.mkdir(exist_ok=True)
    packages = Path(os.environ.get('NUGET_PACKAGES', str(Path.home() / '.nuget/packages')))
    runtime = packages / ('microsoft.netcore.app.runtime.' + target) / '8.0.31'
    for name in ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT']:
        shutil.copyfile(runtime / name, licenses / ('DOTNET-' + name))

def finish_manifest(output, target, python=None):
    files = {str(p.relative_to(output)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in output.rglob('*') if p.is_file() and p.name != 'manifest.json'}
    info = {'progressProtocol': 1, 'drawingTiles': 1, 'target': target, 'readerRevision': 'd7dc111023477d8a9fffc2153139459c95b4f345',
            'ezdxf': '1.4.4', 'files': files}
    if python:
        info['python'] = subprocess.check_output([python, '--version'], text=True).strip()
    (output / 'manifest.json').write_text(json.dumps(info, indent=2), encoding='utf8')
    print('Offline drawing converter ready:', output)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archives', type=Path, nargs=2)
    parser.add_argument('--target', choices=['win-x64', 'osx-arm64', 'osx-x64'],
                        default=('osx-arm64' if platform.machine() == 'arm64' else 'osx-x64')
                        if sys.platform == 'darwin' else 'win-x64')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--dotnet', default='dotnet')
    parser.add_argument('--python', default=sys.executable)
    args = parser.parse_args()
    global_output = args.output.resolve()
    if global_output.exists():
        raise RuntimeError('Runtime already exists; choose a new build directory before rebuilding.')
    if not (ROOT / 'vendor').exists():
        prepare(ROOT / 'vendor', args.archives)
    global_output.mkdir(parents=True)
    if args.target.startswith('osx-'):
        prepare_mac(global_output, args.target, args.dotnet, args.python)
        return
    output = global_output
    subprocess.run([args.dotnet, 'publish', str(ROOT / 'reader/CadReader.csproj'), '-c', 'Release',
                    '-r', 'win-x64', '--self-contained', 'true', '-o', str(output / 'reader')], check=True)
    dotnet_package = Path.home() / '.nuget/packages/microsoft.netcore.app.runtime.win-x64/8.0.31'
    for name in ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT']:
        shutil.copyfile(dotnet_package / name, output / 'reader/licenses' / ('DOTNET-' + name))
    cache = ROOT.parent.parent / 'out-drawing-runtime-cache'
    cache.mkdir(exist_ok=True)
    archive = cache / 'python-3.13.15-embed-amd64.zip'
    if not archive.exists():
        urllib.request.urlretrieve('https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip', archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf':
        raise RuntimeError('Python archive digest mismatch')
    py = output / 'python'
    with zipfile.ZipFile(archive) as z:
        z.extractall(py)
    configure_windows_python(py)
    packages = ['ezdxf==1.4.4', 'numpy==2.4.6', 'fonttools==4.65.0', 'pyparsing==3.3.2', 'typing_extensions==4.16.0', 'Pillow==11.3.0']
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:', '--platform', 'win_amd64',
                    '--python-version', '3.13', '--implementation', 'cp', '--abi', 'cp313',
                    '--target', str(py / 'Lib/site-packages'), '--no-compile', *packages], check=True)
    shutil.copyfile(ROOT / 'render_svg.py', output / 'render_svg.py')
    shutil.copyfile(ROOT / 'tiled_svg.py', output / 'tiled_svg.py')
    subprocess.run([str(py / 'python.exe'), '-B', '-c', 'from ezdxf.addons.drawing import Frontend, svg; import PIL.Image'], check=True)
    subprocess.run([str(py / 'python.exe'), '-B', str(output / 'render_svg.py'), '--help'], check=True)
    finish_manifest(output, args.target)

if __name__ == '__main__':
    main()

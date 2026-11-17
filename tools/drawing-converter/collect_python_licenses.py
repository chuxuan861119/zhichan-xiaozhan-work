"""Collect actual Python runtime notices for the frozen converter."""
import importlib.metadata
import json
from pathlib import Path
import shutil
import sys
import sysconfig

output = Path(sys.argv[1])
inventory = []
for name in ['ezdxf', 'numpy', 'fonttools', 'pyparsing', 'typing_extensions', 'Pillow', 'pyinstaller']:
    dist = importlib.metadata.distribution(name)
    target = output / name
    target.mkdir()
    copied = []
    for entry in dist.files or []:
        if any(part.lower().startswith(('license', 'licence', 'copying', 'notice')) for part in entry.parts):
            source = Path(dist.locate_file(entry))
            if source.is_file():
                destination = target / str(entry).replace('../', '')
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                copied.append(str(destination.relative_to(output)))
    if not copied:
        raise RuntimeError('License files missing for ' + name)
    inventory.append({'name': name, 'version': dist.version, 'notices': copied})
license_file = Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt'
if not license_file.is_file():
    license_file = Path(sys.base_prefix) / 'LICENSE.txt'
if not license_file.is_file():
    raise RuntimeError('Python LICENSE.txt is missing')
shutil.copyfile(license_file, output / 'PYTHON-LICENSE.txt')
(output / 'python-components.json').write_text(json.dumps(inventory, indent=2), encoding='utf8')

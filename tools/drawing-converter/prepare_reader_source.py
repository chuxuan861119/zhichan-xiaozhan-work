"""Prepare pinned MIT reader sources for development; never runs in the viewer.

Archives can be supplied from a local cache for a fully offline rebuild.
The small, exact-match patches leave all original sources and licenses visible.
"""
import argparse
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

ACAD_REV = 'd7dc111023477d8a9fffc2153139459c95b4f345'
UTIL_REV = 'fdf1403ede6e3376a0baa1deac166cbe4d21262e'
ARCHIVES = (
    ('ACadSharp', ACAD_REV, 'e6347e1bba9c66dc6737c47a89f5c50786bb0af85ea4b5a9dffb0952d725a75a'),
    ('CSUtilities', UTIL_REV, 'd997931f9b67c25edb2afbb3a90a331dcc523f507d55decfeb6d81db56dd4b9b'),
)


def patch_once(path, before, after):
    text = path.read_text(encoding='utf-8-sig')
    if text.count(before) != 1:
        raise ValueError(f'Pinned source patch mismatch: {path.name}')
    path.write_text(text.replace(before, after), encoding='utf-8')


def prepare(output, local_archives=None):
    if output.exists():
        raise ValueError('Source directory already exists; refusing to overwrite')
    verified = []
    for index, (name, revision, expected) in enumerate(ARCHIVES):
        if local_archives:
            data = local_archives[index].read_bytes()
        else:
            url = f'https://codeload.github.com/DomCR/{name}/zip/{revision}'
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(30 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'{name}: archive digest mismatch')
        verified.append(data)
    # Both hashes verified before creating output; paths are additionally checked.
    output.mkdir(parents=True, exist_ok=False)
    for data in verified:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for item in archive.infolist():
                if not (output / item.filename).resolve().is_relative_to(output.resolve()):
                    raise ValueError('Unsafe archive path')
            archive.extractall(output)
    source = output / f'ACadSharp-{ACAD_REV}' / 'src' / 'ACadSharp'
    path = source / 'IO/DWG/DwgStreamReaders/DwgObjectReader.cs'
    before = '\t\t\tif (template == null && c.IsAnEntity)'
    after = '''\t\t\t// Read-only compatibility adapter, restricted to the validated DWG generation.
\t\t\tif (template == null && c.IsAnEntity && c.DxfName == "ACIDBLOCKREFERENCE"
\t\t\t\t&& this._version == ACadVersion.AC1032)
\t\t\t{
\t\t\t\ttemplate = this.readReadOnlyDetailReference();
\t\t\t}
''' + before
    patch_once(path, before, after)
    # Equivalent syntax for the .NET 8 SDK compiler; no behavioral change.
    path = source / 'Entities/Entity.cs'
    patch_once(path, 'doc.Materials?.OnRemove += this.tableOnRemove;',
               'if (doc.Materials != null) doc.Materials.OnRemove += this.tableOnRemove;')
    patch_once(path, 'this.Document.Materials?.OnRemove -= this.tableOnRemove;',
               'if (this.Document.Materials != null) this.Document.Materials.OnRemove -= this.tableOnRemove;')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archives', type=Path, nargs=2, metavar=('ACAD_ZIP', 'UTIL_ZIP'))
    args = parser.parse_args()
    prepare(Path(__file__).parent / 'vendor', args.archives)
    print('Pinned sources and read-only adapter prepared; original MIT licenses retained.')

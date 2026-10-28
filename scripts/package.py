"""Create a local source/install ZIP from an explicit allowlist; never include runtime or Git."""
from pathlib import Path
import json
import re
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
files = ['README.md','Install.command','requirements.txt','package.json','project-checks.json',
         'repo-manifest.json','AGENTS.md','CLAUDE.md','.gitignore']
for directory in ['extension','native','scripts','tests','docs','config']:
    files += [str(p.relative_to(ROOT)) for p in (ROOT/directory).rglob('*')
              if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc']
version = json.loads((ROOT/'extension/manifest.json').read_text())['version']
assert re.fullmatch(r'\d+(?:\.\d+){1,3}', version)
output = ROOT/f'dist/country-proxy-{version}.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(ROOT/name,'country-proxy/'+name)
with ZipFile(output) as archive:
    assert all('/.runtime/' not in name and '/.venv/' not in name and '/.git/' not in name
               for name in archive.namelist())
    assert archive.testzip() is None
print(output)
print(f'{len(files)} files; {output.stat().st_size} bytes')

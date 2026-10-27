"""Offline structural validation; never installs or executes downloaded code."""
import ast
import base64
import json
from pathlib import Path
import re
import subprocess

root=Path(__file__).resolve().parents[1]
for folder in ['native','scripts','tests']:
    for p in (root/folder).glob('*.py'):
        ast.parse(p.read_text(), filename=str(p))
for p in (root/'extension').glob('*.js'):
    subprocess.run(['node','--check',str(p)],check=True)
manifest=json.loads((root/'extension/manifest.json').read_text())
assert manifest['manifest_version']==3
assert len(base64.b64decode(manifest['key']))>100
for f in ['background.js','popup.html','options.html']: assert (root/'extension'/f).is_file()
assert set(manifest['permissions'])=={'proxy','storage','nativeMessaging','alarms','privacy'}
assert manifest.get('incognito')=='not_allowed'
cc=json.loads((root/'extension/countries.json').read_text());assert len(cc)==249 and len(set(cc))==249
for p in [root/'README.md',*(root/'docs').glob('*.md')]:
    for target in re.findall(r'\]\(([^)]+)\)',p.read_text()):
        if not target.startswith(('https://','http://','#')): assert (p.parent/target).exists(),(p,target)
print('Python/JS syntax, manifest, ISO catalogue and local documentation links: PASS')

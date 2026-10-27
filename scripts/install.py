#!/usr/bin/env python3
"""Install helper in a private venv; register only its exact Chrome extension ID."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
NAME = 'local.country_proxy'


def extension_id():
    key = json.loads((ROOT/'extension/manifest.json').read_text())['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return ''.join(chr(97 + int(c, 16)) for c in digest)


def install(profile=None, dependencies=True):
    if sys.version_info < (3, 11):
        raise SystemExit('Нужен Python 3.11 или новее.')
    if sys.platform not in ('darwin', 'linux'):
        raise SystemExit('Эта версия поддерживает macOS и Linux.')
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True, mode=0o700)
    venv_path = ROOT / '.venv'
    if not (venv_path/'bin/python').exists():
        venv.EnvBuilder(with_pip=True).create(venv_path)
    python = venv_path/'bin/python'
    if dependencies:
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        '-r', str(ROOT/'requirements.txt')], check=True)
    subprocess.run([str(python), '-I', '-c', 'import proxyscraper, certifi'], check=True)
    wrapper = runtime/'host'
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(str(python)) + ' -I -B ' +
                       shlex.quote(str(ROOT/'native/host.py')) + '\n')
    wrapper.chmod(0o700)
    if profile is None:
        profile = Path.home() / ('Library/Application Support/Google/Chrome' if sys.platform == 'darwin' else '.config/google-chrome')
    destination = Path(profile).expanduser().resolve()/'NativeMessagingHosts'
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {'name': NAME, 'description': 'Country Proxy local helper', 'path': str(wrapper),
                'type': 'stdio', 'allowed_origins': [f'chrome-extension://{extension_id()}/']}
    target = destination/(NAME+'.json')
    if target.exists() and json.loads(target.read_text()).get('path') != str(wrapper):
        raise SystemExit('Другой Country Proxy уже зарегистрирован. Удалите его регистрацию явно.')
    temporary = target.with_suffix('.json.new')
    temporary.write_text(json.dumps(manifest, indent=2)+'\n')
    temporary.chmod(0o600)
    os.replace(temporary, target)
    print('Помощник готов. Расширение:', ROOT/'extension')
    print('Extension ID:', extension_id())
    print('Регистрация:', target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, help='Отдельный user-data-dir для тестов')
    parser.add_argument('--skip-dependencies', action='store_true', help='Использовать уже установленное окружение')
    args = parser.parse_args()
    install(args.profile, not args.skip_dependencies)

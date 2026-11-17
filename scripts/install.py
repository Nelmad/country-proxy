#!/usr/bin/env python3
"""Install helper in a private venv; register only its exact Chrome extension ID."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import venv

ROOT = Path(__file__).resolve().parents[1]
NAME = 'local.country_proxy'


def extension_id():
    key = json.loads((ROOT/'extension/manifest.json').read_text())['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return ''.join(chr(97 + int(c, 16)) for c in digest)


def profile_path(profile=None):
    if profile is None:
        profile = Path.home() / ('Library/Application Support/Google/Chrome' if sys.platform == 'darwin' else '.config/google-chrome')
    return Path(profile).expanduser().resolve()


def launcher_path(profile):
    return ROOT / '.runtime' / ('host-' + hashlib.sha256(os.fsencode(profile)).hexdigest())


def read_registration(target):
    try:
        info = target.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 65536:
        raise ValueError('Unsafe native registration')
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        actual = os.fstat(stream.fileno())
        if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('Native registration changed')
        return stream.read(65537)


def atomic_write(target, data, mode):
    fd, temporary = tempfile.mkstemp(prefix=target.name + '.', dir=target.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def install(profile=None, dependencies=True, data_dir=None, prepare_legacy_rollback=False):
    if sys.version_info < (3, 11):
        raise SystemExit('Нужен Python 3.11 или новее.')
    if sys.platform not in ('darwin', 'linux'):
        raise SystemExit('Эта версия поддерживает macOS и Linux.')
    explicit_profile = profile is not None
    if explicit_profile and data_dir is None and not prepare_legacy_rollback:
        raise ValueError('An explicit --profile requires an explicit --data-dir')
    profile = profile_path(profile)
    wrapper = launcher_path(profile)
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True, mode=0o700)
    info = runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Unsafe .runtime directory; expected owner-only 0700')
    destination = profile/'NativeMessagingHosts'
    destination.mkdir(parents=True, exist_ok=True)
    target = destination/(NAME+'.json')
    before = read_registration(target)
    expected_origins = [f'chrome-extension://{extension_id()}/']
    if before is not None:
        registered = json.loads(before)
        if (registered.get('name') != NAME or registered.get('type') != 'stdio'
                or registered.get('allowed_origins') != expected_origins
                or registered.get('path') not in (str(wrapper), str(runtime/'host'))):
            raise ValueError('Другой Country Proxy уже зарегистрирован. Удалите его регистрацию явно.')
    if prepare_legacy_rollback:
        if data_dir is not None or before is None:
            raise ValueError('Rollback preparation needs an existing exact registration and no --data-dir')
        wrapper = runtime/'host'
    elif data_dir is None:
        # Ordinary Install.command gets private installation-owned persistence;
        # custom/test profiles must supply an exact data-dir themselves.
        sys.path.insert(0, str(ROOT/'native'))
        from history_store import checked_directory
        descriptor, parent = checked_directory(runtime/'data', create=True)
        os.close(descriptor)
        data_dir = parent/wrapper.name.removeprefix('host-')
    if data_dir is not None:
        # The same path policy as the host, before writing a persistent launcher.
        sys.path.insert(0, str(ROOT/'native'))
        from history_store import checked_directory
        descriptor, data_dir = checked_directory(data_dir, create=True)
        os.close(descriptor)
    venv_path = ROOT / '.venv'
    if not (venv_path/'bin/python').exists():
        if prepare_legacy_rollback:
            raise ValueError('Existing helper Python required for rollback preparation')
        venv.EnvBuilder(with_pip=True).create(venv_path)
    python = venv_path/'bin/python'
    if not prepare_legacy_rollback:
        if dependencies:
            subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                            '-r', str(ROOT/'requirements.txt')], check=True)
        subprocess.run([str(python), '-I', '-c', 'import proxyscraper, certifi'], check=True)
    command = [str(python), '-I', '-B', str(ROOT/'native/host.py')]
    if data_dir is not None:
        command += ['--data-dir', str(data_dir)]
    atomic_write(wrapper, ('#!/bin/sh\nexec ' + shlex.join(command) + '\n').encode(), 0o700)
    manifest = {'name': NAME, 'description': 'Country Proxy local helper', 'path': str(wrapper),
                'type': 'stdio', 'allowed_origins': expected_origins}
    if read_registration(target) != before:
        raise ValueError('Native registration changed; refusing replacement')
    atomic_write(target, (json.dumps(manifest, indent=2)+'\n').encode(), 0o600)
    print('Помощник готов. Расширение:', ROOT/'extension')
    print('Extension ID:', extension_id())
    print('Регистрация:', target)
    print('История:', str(data_dir) if data_dir is not None else 'только в памяти')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, help='Отдельный user-data-dir для тестов')
    parser.add_argument('--data-dir', type=Path, help='Папка истории (обязательна с --profile); обычная установка использует .runtime/data/<ключ профиля>')
    parser.add_argument('--skip-dependencies', action='store_true', help='Использовать уже установленное окружение')
    parser.add_argument('--prepare-legacy-rollback', action='store_true', help='Перед возвратом к старому комплекту вернуть exact регистрацию на memory-only .runtime/host')
    args = parser.parse_args()
    try:
        install(args.profile, not args.skip_dependencies, args.data_dir, args.prepare_legacy_rollback)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.exit(1, str(error)+'\n')

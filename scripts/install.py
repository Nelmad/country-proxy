#!/usr/bin/env python3
"""Install helper in a private venv; register only its exact Chrome extension ID."""
import argparse
import base64
import hashlib
import json
import os
import re
from email.parser import BytesParser
from zipfile import ZipFile
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


def checked_venv(require_python=False):
    """Verify the filesystem and actual interpreter target before ensurepip/pip."""
    root = ROOT/'.venv'

    def directory(path):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError(f'Unsafe venv directory: {path.relative_to(ROOT)}')

    try:
        directory(root)
    except FileNotFoundError:
        if require_python:
            raise ValueError('Unsafe venv: missing environment; use a fresh bundle')
        return False
    if not any(root.iterdir()):
        if require_python:
            raise ValueError('Unsafe venv: incomplete environment; use a fresh bundle')
        return False
    binary = root/'bin'
    try:
        directory(binary)
    except FileNotFoundError:
        raise ValueError('Unsafe venv: incomplete environment; use a fresh bundle') from None
    # Check pip's destination chains. Linux's internal lib64 -> lib alias is
    # allowed only inside this venv; executable links to base Python are normal.
    for name in ('lib', 'lib64'):
        library = root/name
        if not library.exists() and not library.is_symlink():
            continue
        if name == 'lib64' and library.is_symlink() and library.resolve() == root/'lib':
            directory(root/'lib')
            if library.lstat().st_uid != os.getuid():
                raise ValueError('Unsafe venv lib64 owner')
        else:
            directory(library)
        for version in library.iterdir():
            if version.name.startswith('python'):
                directory(version)
                packages = version/'site-packages'
                if packages.exists() or packages.is_symlink():
                    directory(packages)
    python = binary/'python'
    if not python.exists() or not stat.S_ISREG(python.stat().st_mode):
        raise ValueError('Unsafe venv: incomplete environment; use a fresh bundle')
    config = root/'pyvenv.cfg'
    try:
        info = config.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 65536:
            raise ValueError('Unsafe venv configuration; use a fresh bundle')
        descriptor = os.open(config, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            actual = os.fstat(stream.fileno())
            if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError('Unsafe venv configuration changed')
            text = stream.read(65537).decode('utf-8')
        fields = {}
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, separator, value = line.partition('=')
            key = key.strip().casefold()
            if not separator or key in fields:
                raise ValueError('Unsafe venv configuration syntax')
            fields[key] = value.strip()
        if fields.get('include-system-site-packages', '').casefold() != 'false':
            raise ValueError('Unsafe venv: system site-packages must be disabled')
    except (OSError, UnicodeError) as error:
        raise ValueError('Unsafe venv configuration; use a fresh bundle') from error
    code = '''import os,pathlib,site,sys,sysconfig
expected=pathlib.Path(sys.argv[1])
assert sys.version_info >= (3,11), 'Python 3.11+ required'
assert sys.prefix != sys.base_prefix and sys.exec_prefix != sys.base_exec_prefix, 'Not a virtual environment'
assert os.path.samefile(sys.prefix,expected) and os.path.samefile(sys.exec_prefix,expected), 'Foreign virtual environment'
assert site.ENABLE_USER_SITE is False, 'User site-packages must be disabled'
assert all(pathlib.Path(sysconfig.get_path(k)).resolve().is_relative_to(expected) for k in ('purelib','platlib')), 'Foreign install directory'
'''
    try:
        subprocess.run([str(python), '-I', '-B', '-c', code, str(root)], check=True,
                       capture_output=True, text=True, env=pip_environment(root))
    except subprocess.CalledProcessError as error:
        raise ValueError('Unsafe venv interpreter target; use a fresh bundle') from error
    return True


def registration_directory(profile):
    """Create/check only an ordinary owned NativeMessagingHosts under exact profile."""
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = profile.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or profile.resolve() != profile:
        raise ValueError('Unsafe registration directory profile')
    destination = profile/'NativeMessagingHosts'
    try:
        info = destination.lstat()
    except FileNotFoundError:
        destination.mkdir(mode=0o700)
        info = destination.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('Unsafe registration directory: NativeMessagingHosts must be ordinary and owned')
    return destination


def pip_environment(temporary):
    # Ignore pip config at every scope and inherited pip/Python overrides. The
    # interpreter/ensurepip is a prerequisite; no pip upgrade is downloaded.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('PIP_', 'PYTHON'))}
    env.update(PIP_CONFIG_FILE=os.devnull, TMPDIR=str(temporary))
    return env


def pip_command(python):
    return [str(python), '-I', '-m', 'pip', '--isolated',
            '--disable-pip-version-check', '--no-input', '--no-cache-dir']


def requirement_names():
    names = set()
    for line in (ROOT/'requirements.txt').read_text().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        names.add(re.sub(r'[-_.]+', '-', re.split(r'==| @ ', line, maxsplit=1)[0]).lower())
    return names


def verify_environment(python, names, versions=None, env=None):
    # The venv is installation-owned. Refuse foreign packages rather than
    # silently retain them or remove packages the user may have added.
    code = '''import importlib.metadata as m,json,re,sys
assert sys.version_info >= (3,11), 'Existing venv needs Python 3.11+'
normalize=lambda s: re.sub(r'[-_.]+','-',s).lower()
actual={normalize(d.metadata['Name']):d.version for d in m.distributions()}
allowed=set(json.loads(sys.argv[1]))
assert not set(actual)-allowed, 'Unexpected packages in .venv; use a fresh bundle: '+','.join(sorted(set(actual)-allowed))
expected=json.loads(sys.argv[2])
assert all(actual.get(n)==v for n,v in expected.items()), 'Installed versions differ from verified wheels'
'''
    subprocess.run([str(python), '-I', '-c', code, json.dumps(sorted(names)), json.dumps(versions or {})],
                   check=True, env=env)


def install_dependencies(python, runtime):
    """Build from locked inputs in a fresh env, then install hashed local wheels."""
    if Path(python) != ROOT/'.venv/bin/python':
        raise ValueError('Unsafe venv interpreter path')
    checked_venv(require_python=True)
    names = requirement_names()
    with tempfile.TemporaryDirectory(prefix='dependencies-', dir=runtime) as temporary:
        temporary = Path(temporary)
        env = pip_environment(temporary)
        verify_environment(python, names | {'pip', 'setuptools', 'wheel'}, env=env)
        build_env, wheels = temporary/'build-env', temporary/'wheels'
        subprocess.run([str(python), '-I', '-m', 'venv', str(build_env)], check=True, env=env)
        build_python = build_env/'bin/python'
        source_pip = pip_command(build_python)
        subprocess.run(source_pip + ['install', '--index-url', 'https://pypi.org/simple',
                       '--require-hashes', '--only-binary=:all:', '--no-deps', '--force-reinstall',
                       '-r', str(ROOT/'build-requirements.txt')], check=True, env=env)
        # Explicit source URLs remain buildable with only-binary; all index
        # requirements must be wheels. No backend dependencies are resolved.
        subprocess.run(source_pip + ['wheel', '--index-url', 'https://pypi.org/simple',
                       '--require-hashes', '--only-binary=:all:', '--no-deps', '--no-build-isolation',
                       '--wheel-dir', str(wheels), '-r', str(ROOT/'requirements.txt')], check=True, env=env)
        versions, hashes, locked_wheels = {}, {}, []
        for wheel in sorted(wheels.iterdir()):
            if not wheel.is_file() or wheel.suffix != '.whl':
                raise ValueError('Unexpected build output')
            with ZipFile(wheel) as archive:
                metadata_paths = [n for n in archive.namelist() if n.endswith('.dist-info/METADATA')]
                if len(metadata_paths) != 1:
                    raise ValueError('Expected exactly one wheel metadata file')
                metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
            name = re.sub(r'[-_.]+', '-', metadata['Name']).lower()
            if name in versions:
                raise ValueError('Duplicate wheel distribution')
            versions[name] = metadata['Version']
            hashes[wheel.name] = hashlib.sha256(wheel.read_bytes()).hexdigest()
            locked_wheels.append(f'{name} @ {wheel.as_uri()} --hash=sha256:{hashes[wheel.name]}')
        if set(versions) != names:
            raise ValueError('Built wheel inventory differs from locked requirements')
        lock = temporary/'verified-wheels.txt'
        lock.write_text('\n'.join(locked_wheels) + '\n')
        runtime_pip = pip_command(python)
        subprocess.run(runtime_pip + ['install', '--no-index', '--require-hashes', '--no-deps',
                       '--force-reinstall', '-r', str(lock)], check=True, env=env)
        # Python 3.11 ensurepip may supply setuptools; runtime needs only pip and
        # the declared graph. The source builder lives exclusively in its temp env.
        subprocess.run(runtime_pip + ['uninstall', '--yes', 'setuptools', 'wheel'], check=True, env=env)
        verify_environment(python, names | {'pip'}, versions, env)
        subprocess.run(runtime_pip + ['check'], check=True, env=env)
        requirements = (ROOT/'requirements.txt').read_bytes()
        source_hash = re.findall(rb'#[s]ha256=([0-9a-f]{64})', requirements)
        if len(source_hash) != 1:
            raise ValueError('Expected one locked source archive')
        receipt = {'schemaVersion': 1, 'requirementsSHA256': hashlib.sha256(requirements).hexdigest(),
                   'buildRequirementsSHA256': hashlib.sha256((ROOT/'build-requirements.txt').read_bytes()).hexdigest(),
                   'sourceArchiveSHA256': source_hash[0].decode(), 'distributions': versions, 'wheels': hashes,
                   'buildIsolation': 'fresh-venv-with-hash-locked-backend'}
        atomic_write(runtime/'dependency-install.json', (json.dumps(receipt, indent=2, sort_keys=True)+'\n').encode(), 0o600)


def install(profile=None, dependencies=True, data_dir=None, prepare_legacy_rollback=False):
    if sys.version_info < (3, 11):
        raise SystemExit('Нужен Python 3.11 или новее.')
    if sys.platform not in ('darwin', 'linux'):
        raise SystemExit('Эта версия поддерживает macOS и Linux.')
    explicit_profile = profile is not None
    if explicit_profile and data_dir is None and not prepare_legacy_rollback:
        raise ValueError('An explicit --profile requires an explicit --data-dir')
    existing_python = checked_venv()
    profile = profile_path(profile)
    wrapper = launcher_path(profile)
    destination = registration_directory(profile)
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True, mode=0o700)
    info = runtime.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Unsafe .runtime directory; expected owner-only 0700')
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
    if not existing_python:
        if prepare_legacy_rollback:
            raise ValueError('Existing helper Python required for rollback preparation')
        venv.EnvBuilder(with_pip=True).create(venv_path)
    checked_venv(require_python=True)
    python = venv_path/'bin/python'
    if not prepare_legacy_rollback:
        if dependencies:
            install_dependencies(python, runtime)
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

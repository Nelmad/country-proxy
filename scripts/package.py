"""Build a deterministic local ZIP; this does not verify a Git commit or publish a release."""
from pathlib import Path
import hashlib
import json
import os
import re
import stat
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'Install.command',
    'requirements.txt', 'package.json', 'project-checks.json',
    'repo-manifest.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore',
)
SOURCE_DIRS = ('extension', 'native', 'scripts', 'tests', 'docs', 'config', '.github')
FORBIDDEN_NAMES = {'.runtime', '.venv', '.git', '.env', '.netrc', '.npmrc', '.pypirc',
                   'credentials', 'secrets', 'id_rsa', 'id_ed25519', 'local.json'}
FORBIDDEN_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.kdbx'}
HISTORY_NAMES = {'endpoint-history.json', 'endpoint-history.lock'}
BUILD_MANIFEST = 'BUILD-MANIFEST.json'
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def release_version(value):
    # The project uses three components; Chrome accepts only bounded numeric fields.
    if (not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value)
            or any(int(part) > 65535 for part in value.split('.'))
            or all(int(part) == 0 for part in value.split('.'))):
        raise ValueError('Invalid version: use three Chrome-compatible integers (0..65535), not all zero')
    return value


def checked_kind(path, root):
    """Check metadata before reading; never traverse a symbolic link."""
    relative = path.relative_to(root)
    name = path.name.casefold()
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode):
        raise ValueError(f'Symlink is not allowed in the package: {relative}')
    if (name in FORBIDDEN_NAMES or name in HISTORY_NAMES
            or name.startswith(('.endpoint-history-', '.env', 'credentials.', 'secrets.'))
            or path.suffix.casefold() in FORBIDDEN_SUFFIXES):
        raise ValueError(f'Private or runtime path is not allowed in the package: {relative}')
    if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
        raise ValueError(f'Only ordinary files/directories may be packaged: {relative}')
    return mode


def source_files(root):
    """Allowlisted roots only; caches are omitted, suspicious nested paths fail closed."""
    files = []
    for name in ROOT_FILES:
        path = root / name
        if not stat.S_ISREG(checked_kind(path, root)):
            raise ValueError(f'Expected a file: {name}')
        files.append(path)

    def walk(directory):
        for path in sorted(directory.iterdir()):
            mode = checked_kind(path, root)
            if path.name in ('__pycache__', '.DS_Store') or path.suffix == '.pyc':
                continue
            if stat.S_ISDIR(mode):
                walk(path)
            else:
                files.append(path)

    for name in SOURCE_DIRS:
        path = root / name
        if not path.exists() and not path.is_symlink():
            continue
        if not stat.S_ISDIR(checked_kind(path, root)):
            raise ValueError(f'Expected a directory: {name}')
        walk(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def read_regular(path):
    # O_NOFOLLOW also refuses a file swapped for a symlink after the metadata check.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError(f'Expected an ordinary file: {path.name}')
        return stream.read()


def build(root=ROOT):
    root = Path(root)
    if root.is_symlink():
        raise ValueError('The package source root must not be a symlink')
    root = root.resolve()
    contents = {path.relative_to(root).as_posix(): read_regular(path)
                for path in source_files(root)}
    version = release_version(json.loads(contents['extension/manifest.json'])['version'])
    manifest = {
        'schema_version': 1,
        'version': version,
        'build_kind': 'local-working-tree',
        'release_verified': False,
        'notice': 'Local build only; no Git commit, release approval or test result is attested.',
        # The generated manifest cannot hash itself. The ZIP checksum covers it.
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()},
    }
    contents[BUILD_MANIFEST] = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    destination = root / 'dist'
    if destination.is_symlink():
        raise ValueError('dist must not be a symlink')
    destination.mkdir(exist_ok=True)
    output = destination / f'country-proxy-{version}.zip'
    checksum = output.with_suffix(output.suffix + '.sha256')
    if output.is_symlink() or checksum.is_symlink():
        raise ValueError('Package output must not be a symlink')
    with ZipFile(output, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(contents.items()):
            info = ZipInfo('country-proxy/' + name, date_time=FIXED_TIME)
            info.create_system = 3
            info.compress_type = ZIP_DEFLATED
            mode = 0o755 if name == 'Install.command' else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            archive.writestr(info, data, compresslevel=9)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    checksum.write_text(f'{digest}  {output.name}\n', encoding='utf-8')
    return output


def main():
    output = build()
    print('LOCAL BUILD — not a published release or a verified Git commit')
    print(output)
    print(output.with_suffix(output.suffix + '.sha256'))
    print(f'{output.stat().st_size} bytes; BUILD-MANIFEST.json contains source SHA-256 hashes')


if __name__ == '__main__':
    main()

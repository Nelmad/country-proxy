#!/usr/bin/env python3
"""Validate and extract a bundle as data using the trusted checkout's inventory."""
import hashlib
import json
import os
import re
import shutil
import unicodedata
from pathlib import Path, PurePosixPath
import stat
import sys
from zipfile import ZipFile

# -I excludes the script directory. Add only this trusted checkout, never the ZIP.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from package import BUILD_MANIFEST, ROOT_FILES, SOURCE_DIRS, FORBIDDEN_NAMES, FORBIDDEN_SUFFIXES, HISTORY_NAMES, release_version


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def filesystem_key(value):
    return unicodedata.normalize('NFC', unicodedata.normalize('NFC', value).casefold())


def extract(source, target):
    require(sys.version_info >= (3, 11), 'Python 3.11+ required')
    source, target = Path(source), Path(target)
    require(source.is_absolute() and not source.is_symlink(), 'ZIP must be an absolute ordinary file')
    require(target.is_absolute() and not target.exists() and not target.is_symlink(), 'Target must be new and absolute')
    # Resolve the existing parent before any writes; do not follow a target alias.
    require(target.parent.resolve() == target.parent, 'Target parent must not contain aliases')
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_size <= 134217728, 'ZIP type or size')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        stream.seek(0)
        with ZipFile(stream) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= 3000 and sum(x.file_size for x in entries) <= 67108864, 'ZIP entry/total size bounds')
            names, folded_names, blobs, modes = set(), set(), {}, {}
            path_kinds = {}
            for entry in entries:
                name = entry.filename
                parts = PurePosixPath(name).parts
                require('\\' not in name and '\x00' not in name and not name.startswith('/') and len(parts) >= 2, 'ZIP path syntax')
                require(name == '/'.join(parts) + ('/' if entry.is_dir() else ''), 'ZIP path normalization')
                require(parts[0] == 'country-proxy' and all(
                    x not in ('', '.', '..') and x.casefold() not in FORBIDDEN_NAMES | HISTORY_NAMES | {'__pycache__'}
                    and not x.casefold().startswith(('.endpoint-history-', '.env', 'credentials.', 'secrets.'))
                    for x in parts), 'ZIP private/escaping path')
                require(name not in names and filesystem_key(name) not in folded_names, 'ZIP duplicate/aliased entry')
                names.add(name)
                folded_names.add(filesystem_key(name))
                mode = entry.external_attr >> 16
                require(not stat.S_ISLNK(mode) and not entry.flag_bits & 1, 'ZIP symlink/encryption')
                # Track implicit parents as well as explicit entries. A file may
                # never also be a parent, even under case-insensitive spelling.
                for depth in range(2, len(parts) + 1):
                    prefix = '/'.join(parts[:depth])
                    key = filesystem_key(prefix)
                    kind = 'directory' if depth < len(parts) or entry.is_dir() else 'file'
                    previous = path_kinds.get(key)
                    require(previous is None or previous == (prefix, kind), 'ZIP parent/type/alias conflict')
                    path_kinds[key] = (prefix, kind)
                if entry.is_dir():
                    require(parts[1] in SOURCE_DIRS and stat.S_IFMT(mode) in (0, stat.S_IFDIR), 'ZIP directory type/root')
                    continue
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and entry.file_size <= 8388608, 'ZIP file type/size')
                require((len(parts) == 2 and parts[1] in (*ROOT_FILES, BUILD_MANIFEST)) or (len(parts) > 2 and parts[1] in SOURCE_DIRS), 'ZIP unlisted root')
                require(PurePosixPath(name).suffix.casefold() not in FORBIDDEN_SUFFIXES | {'.pyc'}, 'ZIP private/cache suffix')
                relative = '/'.join(parts[1:])
                blobs[relative] = archive.read(entry)
                modes[relative] = stat.S_IMODE(mode)
            build = json.loads(blobs[BUILD_MANIFEST])
            require(isinstance(build, dict) and type(build.get('schema_version')) is int and build['schema_version'] == 1, 'ZIP manifest schema')
            version = release_version(build.get('version'))
            require(isinstance(build.get('files'), dict) and all(
                isinstance(name, str) and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest)
                for name, digest in build['files'].items()), 'ZIP manifest files schema')
            extension = json.loads(blobs.get('extension/manifest.json', b'null'))
            require(isinstance(extension, dict), 'ZIP extension manifest schema')
            require(release_version(extension.get('version')) == version, 'ZIP extension/build version mismatch')
            require(set(blobs) - {BUILD_MANIFEST} == set(build['files']), 'ZIP manifest inventory')
            require(set(ROOT_FILES).issubset(blobs), 'ZIP required root files')
            require(all(hashlib.sha256(blobs[n]).hexdigest() == value for n, value in build['files'].items()), 'ZIP inventory hash')
            require(modes['Install.command'] == 0o755 and all(modes[n] == 0o644 for n in blobs if n != 'Install.command'), 'ZIP file modes')
        after = os.fstat(stream.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'ZIP changed during validation')
    # No archive-supplied directory/symlink is created. All content checks precede writes.
    target.mkdir(mode=0o700)
    created = target.lstat()
    try:
        for relative, data in sorted(blobs.items()):
            output = target.joinpath(*relative.split('/'))
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open('xb') as out:
                out.write(data)
            output.chmod(modes[relative])
    except BaseException:
        # Remove only this newly created target, never an existing/replaced path.
        try:
            current = target.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                shutil.rmtree(target)
        raise
    return {'zipSHA256': digest, 'files': len(blobs), 'python': '.'.join(map(str, sys.version_info[:3])), 'buildVersion': version}


if __name__ == '__main__':
    print(json.dumps(extract(sys.argv[1], sys.argv[2])))

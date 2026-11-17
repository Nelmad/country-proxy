#!/usr/bin/env python3
"""Snapshot reviewed source and verify a local release candidate. Never creates refs/releases."""
import argparse
from datetime import date
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
from zipfile import ZipFile
from urllib.parse import quote, unquote, urlsplit

from package import BUILD_MANIFEST, ROOT, build, read_regular, release_version, source_files

SCHEMA = 1


def sha(data):
    return hashlib.sha256(data).hexdigest()


def identity(tag, commit):
    match = re.fullmatch(r'v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-rc\.([1-9][0-9]*))?', tag)
    if not match or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected vX.Y.Z[-rc.N] and a full lowercase 40-character commit SHA')
    return release_version(match[1]), bool(match[2])


def changelog_section(text, tag):
    label = tag.removeprefix('v')
    headings = list(re.finditer(r'^## \[([^]\n]+)\](?: - (\d{4}-\d{2}-\d{2}))?[^\n]*$', text, re.MULTILINE))
    matches = [(i, heading) for i, heading in enumerate(headings) if heading[1] == label]
    if len(matches) != 1 or not matches[0][1][2]:
        raise ValueError('Exactly one finalized dated CHANGELOG section matching the tag is required')
    i, heading = matches[0]
    if heading[0] != f'## [{label}] - {heading[2]}':
        raise ValueError('Finalized CHANGELOG heading must contain only version and date')
    date.fromisoformat(heading[2])
    section = text[heading.end():headings[i + 1].start() if i + 1 < len(headings) else len(text)].strip()
    if not section or re.search(r'\b(?:TODO|TBD)\b', section, re.IGNORECASE):
        raise ValueError('CHANGELOG section must contain finalized release notes, not placeholders')
    return section


def release_links(text, tag):
    """Make simple CHANGELOG inline links portable to GitHub Release notes.

    Code examples are left alone. Ambiguous relative titles/parentheses and
    reference-style links must be written as explicit absolute links first.
    """
    base = f'https://github.com/Nelmad/country-proxy/blob/{tag}/'
    link = re.compile(r'(?<!\\)(!?\[[^\]\n]+\])\(([^)\n]*)\)')

    def replace(match):
        label, raw = match.groups()
        destination = raw[1:-1] if raw.startswith('<') and raw.endswith('>') else raw
        parsed = urlsplit(destination)
        if parsed.scheme in ('https', 'http', 'mailto'):
            return match[0]
        if parsed.scheme or parsed.netloc:
            raise ValueError('Unsupported release-note link; use an explicit HTTPS URL')
        if (not destination or '(' in destination or '\\' in destination
                or (not raw.startswith('<') and any(c.isspace() for c in destination))):
            raise ValueError('Ambiguous relative release-note link; use a simple inline link or explicit HTTPS URL')
        target = posixpath.normpath(unquote(parsed.path or 'CHANGELOG.md'))
        if target.startswith('/') or target in ('.', '..') or target.startswith('../'):
            raise ValueError('Release-note link must remain inside the repository')
        url = base + quote(target, safe='/-._~')
        if parsed.query:
            url += '?' + parsed.query
        if parsed.fragment:
            url += '#' + quote(unquote(parsed.fragment), safe='-._~')
        return f'{label}({url})'

    output = []
    fence = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if marker:
            value = marker[1]
            if fence is None:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = None
            output.append(line)
            continue
        if fence:
            output.append(line)
            continue
        # Preserve inline code before interpreting Markdown destinations.
        parts = re.split(r'(`+[^`]*`+)', line)
        for index in range(0, len(parts), 2):
            if re.search(r'\[[^]\n]+\]\[[^]\n]*\]|^\s*\[[^]\n]+\]:', parts[index]):
                raise ValueError('Reference-style release-note links must use explicit inline destinations')
            parts[index] = link.sub(replace, parts[index])
        output.append(''.join(parts))
    return ''.join(output)


def inspect_source(root, tag, commit):
    version, prerelease = identity(tag, commit)
    paths = source_files(root)
    contents = {p.relative_to(root).as_posix(): read_regular(p) for p in paths}
    manifest = json.loads(contents['extension/manifest.json'])
    if manifest['version'] != version:
        raise ValueError('Tag and numeric manifest version differ')
    if prerelease and manifest.get('version_name') not in (tag, tag.removeprefix('v')):
        raise ValueError('RC manifest version_name must match the RC tag (optional v prefix)')
    if not prerelease and manifest.get('version_name', version) not in (version, tag):
        raise ValueError('Stable release cannot retain an RC or unrelated version_name')
    notes = changelog_section(contents['CHANGELOG.md'].decode(), tag)
    inventory = {name: sha(data) for name, data in contents.items()}
    return {'schema_version': SCHEMA, 'tag': tag, 'commit': commit, 'version': version,
            'prerelease': prerelease, 'source_files': inventory, 'changes': notes}


def snapshot(root, tag, commit, destination):
    record = inspect_source(root, tag, commit)
    destination.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
    return record


def verify_archive(archive_path, record):
    expected = record['source_files']
    with ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != {
                'country-proxy/' + name for name in [*expected, BUILD_MANIFEST]}:
            raise ValueError('ZIP has missing, additional or duplicate entries')
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC failed')
        inventory = json.loads(archive.read('country-proxy/' + BUILD_MANIFEST))
        if (inventory.get('files') != expected or inventory.get('version') != record['version']
                or inventory.get('release_verified') is not False):
            raise ValueError('ZIP inventory differs from the reviewed snapshot')
        for name, digest in expected.items():
            if sha(archive.read('country-proxy/' + name)) != digest:
                raise ValueError('ZIP contents differ from reviewed source: ' + name)


def prepare(root, snapshot_path, tag, commit, output):
    record = json.loads(read_regular(snapshot_path))
    current = inspect_source(root, tag, commit)
    if record != current:
        raise ValueError('Source changed after the pre-test snapshot')
    rendered_changes = release_links(record['changes'], tag)
    archive = build(root)
    if inspect_source(root, tag, commit) != record:
        raise ValueError('Source changed during packaging')
    verify_archive(archive, record)
    checksum = archive.with_suffix('.zip.sha256')
    zip_sha = sha(read_regular(archive))
    if read_regular(checksum).decode() != f'{zip_sha}  {archive.name}\n':
        raise ValueError('ZIP checksum sidecar does not match')
    output.mkdir(parents=True, exist_ok=False)
    for source in (archive, checksum):
        (output / source.name).write_bytes(read_regular(source))
    notes = (
        f'# Country Proxy {tag}\n\n{rendered_changes}\n\n'
        f'Commit: `{commit}`.\n\n'
        f'Bundle: `{archive.name}`; SHA-256: `{zip_sha}`.\n\n'
        f'[English setup and recovery](https://github.com/Nelmad/country-proxy/blob/{tag}/docs/getting-started.md) · '
        f'[Установка, обновление и откат (русский)](https://github.com/Nelmad/country-proxy/blob/{tag}/docs/installation.md) · '
        f'[Verification and limits](https://github.com/Nelmad/country-proxy/blob/{tag}/docs/verification.md).\n\n'
        'Browser acceptance is recorded separately; CI does not perform it. '
        'A GitHub Release does not update an installed extension automatically.\n'
    )
    notes_path = output / 'release-notes.md'
    notes_path.write_text(notes)
    metadata = {**record, 'kind': 'draft-release-candidate', 'published': False,
                'assets': {p.name: sha(read_regular(p)) for p in output.iterdir()}}
    metadata_path = output / 'release-metadata.json'
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
    return {'zip_name': archive.name, 'zip_sha256': zip_sha,
            'checksum_sha256': sha(read_regular(output / checksum.name)),
            'notes_sha256': sha(read_regular(notes_path)),
            'metadata_sha256': sha(read_regular(metadata_path))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('snapshot', 'prepare'))
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if args.command == 'snapshot':
        snapshot(args.root, args.tag, args.commit, args.snapshot)
    else:
        if args.output is None:
            parser.error('--output is required for prepare')
        values = prepare(args.root, args.snapshot, args.tag, args.commit, args.output)
        destination = os.environ.get('GITHUB_OUTPUT')
        if destination:
            with open(destination, 'a') as stream:
                for key, value in values.items():
                    stream.write(f'{key}={value}\n')
        print(json.dumps(values, sort_keys=True))


if __name__ == '__main__':
    main()

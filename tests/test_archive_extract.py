"""Offline release ZIP → exact fresh-install extractor compatibility/security tests."""
import hashlib
import copy
import warnings
import json
from pathlib import Path
import stat
import subprocess
from unittest.mock import patch
import sys
import tempfile
import unittest
from zipfile import ZipFile, ZipInfo

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import archive_extract
import package


class ArchiveExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root, self.target = self.base/'source', self.base/'extracted'
        self.root.mkdir()
        for name in package.ROOT_FILES:
            (self.root/name).write_bytes(('fixture: '+name+'\n').encode())
        (self.root/'extension').mkdir()
        (self.root/'extension/manifest.json').write_text('{"version":"1.0.0"}')
        self.zip = package.build(self.root)

    def rewrite(self, change):
        with ZipFile(self.zip) as archive:
            entries = [(info, archive.read(info)) for info in archive.infolist()]
        change(entries)
        with warnings.catch_warnings():
            warnings.filterwarnings('ignore', message='Duplicate name:')
            with ZipFile(self.zip, 'w') as archive:
                for info, body in entries:
                    archive.writestr(info, body)

    def test_built_bundle_extracts_with_exact_fresh_install_command(self):
        # This is the same trusted script/isolated interpreter boundary used by Node.
        process = subprocess.run([sys.executable, '-I', '-B', str(SCRIPTS/'archive_extract.py'),
                                  str(self.zip), str(self.target)], capture_output=True, text=True, check=True)
        result = json.loads(process.stdout)
        self.assertEqual(result['buildVersion'], '1.0.0')
        self.assertEqual(result['zipSHA256'], hashlib.sha256(self.zip.read_bytes()).hexdigest())
        for name in package.ROOT_FILES:
            self.assertEqual((self.target/name).read_bytes(), (self.root/name).read_bytes())
        self.assertTrue({'LICENSE', 'NOTICE', 'requirements.txt', 'build-requirements.txt'}.issubset(package.ROOT_FILES))
        self.assertEqual((self.target/'Install.command').stat().st_mode & 0o777, 0o755)
        harness = (SCRIPTS.parent/'tests/fresh-install.mjs').read_text()
        self.assertIn("['-I','-B',extractor,zip,app]", harness)
        self.assertIn("path.join(root,'scripts/archive_extract.py')", harness)
        self.assertNotIn('const extract=String.raw', harness)

    def test_bad_paths_types_modes_hashes_and_unlisted_files_fail_before_writes(self):
        original = self.zip.read_bytes()
        for mutation in ('traversal', 'symlink', 'mode', 'hash', 'duplicate', 'private', 'unlisted', 'missing-legal'):
            with self.subTest(mutation=mutation):
                self.zip.write_bytes(original)
                def change(entries):
                    index = next(i for i, (info, _) in enumerate(entries) if info.filename.endswith('/LICENSE'))
                    info, body = entries[index]
                    if mutation == 'traversal':
                        info.filename = 'country-proxy/../escape'
                    elif mutation == 'symlink':
                        info.external_attr = (stat.S_IFLNK | 0o644) << 16
                    elif mutation == 'mode':
                        info.external_attr = (stat.S_IFREG | 0o777) << 16
                    elif mutation == 'hash':
                        entries[index] = info, body+b'changed'
                    elif mutation == 'duplicate':
                        entries.append((copy.copy(info), body))
                    elif mutation == 'private':
                        info.filename = 'country-proxy/config/.env.local'
                    elif mutation == 'unlisted':
                        info.filename = 'country-proxy/UNREVIEWED.txt'
                    else:
                        entries.pop(index)
                self.rewrite(change)
                with self.assertRaises(ValueError):
                    archive_extract.extract(self.zip, self.target)
                self.assertFalse(self.target.exists())
                self.assertFalse((self.base/'escape').exists())

    def test_self_consistent_file_parent_and_casefold_prefix_conflicts_fail_before_writes(self):
        original = self.zip.read_bytes()
        cases = [('scripts/a', 'scripts/a/b'), ('scripts/A', 'scripts/a/b'),
                 ('scripts/A/one', 'scripts/a/two'), ('scripts/a', 'scripts/a/'),
                 ('scripts/A', 'scripts/a/')]
        for paths in cases:
            with self.subTest(paths=paths):
                self.zip.write_bytes(original)
                def change(entries):
                    manifest_index = next(i for i,(info,_) in enumerate(entries) if info.filename.endswith('/BUILD-MANIFEST.json'))
                    info, body = entries[manifest_index]
                    manifest = json.loads(body)
                    for path in paths:
                        member = ZipInfo('country-proxy/'+path)
                        member.create_system = 3
                        if path.endswith('/'):
                            member.external_attr = (stat.S_IFDIR | 0o755) << 16
                            data = b''
                        else:
                            member.external_attr = (stat.S_IFREG | 0o644) << 16
                            data = b'consistent inventory bytes'
                            manifest['files'][path] = hashlib.sha256(data).hexdigest()
                        entries.append((member, data))
                    entries[manifest_index] = info, json.dumps(manifest).encode()
                self.rewrite(change)
                with self.assertRaisesRegex(ValueError, 'ZIP.*(?:parent|alias|conflict)'):
                    archive_extract.extract(self.zip, self.target)
                self.assertFalse(self.target.exists(), 'Validation created partial extracted data')

    def test_manifest_shape_version_and_extension_agreement_precede_all_writes(self):
        original = self.zip.read_bytes()
        for mutation in ('array', 'missing-version', 'invalid-version', 'version-mismatch', 'invalid-files', 'invalid-schema'):
            with self.subTest(mutation=mutation):
                self.zip.write_bytes(original)
                def change(entries):
                    index = next(i for i,(info,_) in enumerate(entries) if info.filename.endswith('/BUILD-MANIFEST.json'))
                    info, body = entries[index]
                    manifest = json.loads(body)
                    if mutation == 'array': manifest = []
                    elif mutation == 'missing-version': manifest.pop('version')
                    elif mutation == 'invalid-version': manifest['version'] = '../outside'
                    elif mutation == 'version-mismatch': manifest['version'] = '1.0.2'
                    elif mutation == 'invalid-files': manifest['files'] = []
                    else: manifest['schema_version'] = True
                    entries[index] = info, json.dumps(manifest).encode()
                self.rewrite(change)
                with self.assertRaises(ValueError):
                    archive_extract.extract(self.zip, self.target)
                self.assertFalse(self.target.exists())

    def test_macos_unicode_normalization_aliases_are_rejected_before_writes(self):
        def change(entries):
            index = next(i for i,(info,_) in enumerate(entries) if info.filename.endswith('/BUILD-MANIFEST.json'))
            info, body = entries[index]
            manifest = json.loads(body)
            for path in ('scripts/caf\u00e9/one', 'scripts/cafe\u0301/two'):
                member = ZipInfo('country-proxy/'+path)
                member.external_attr = (stat.S_IFREG | 0o644) << 16
                data = b'Unicode prefix fixture'
                entries.append((member, data))
                manifest['files'][path] = hashlib.sha256(data).hexdigest()
            entries[index] = info, json.dumps(manifest).encode()
        self.rewrite(change)
        with self.assertRaisesRegex(ValueError, 'alias|conflict'):
            archive_extract.extract(self.zip, self.target)
        self.assertFalse(self.target.exists())

    def test_operational_write_failure_cleans_new_target_and_allows_retry(self):
        real_open = Path.open
        def fail_output(path, *args, **kwargs):
            if path == self.target/'LICENSE' and args and args[0] == 'xb':
                raise OSError('injected write failure')
            return real_open(path, *args, **kwargs)
        with patch.object(Path, 'open', fail_output):
            with self.assertRaisesRegex(OSError, 'injected write failure'):
                archive_extract.extract(self.zip, self.target)
        self.assertFalse(self.target.exists())
        result = archive_extract.extract(self.zip, self.target)
        self.assertEqual(result['buildVersion'], '1.0.0')

    def test_archive_size_and_entry_count_bounds_precede_extraction(self):
        with ZipFile(self.zip, 'a') as archive:
            for number in range(3001):
                archive.writestr('country-proxy/docs/entry-'+str(number), b'')
        with self.assertRaisesRegex(ValueError, 'bounds'):
            archive_extract.extract(self.zip, self.target)
        self.assertFalse(self.target.exists())

    def test_existing_target_or_parent_alias_is_never_written(self):
        self.target.mkdir()
        marker = self.target/'marker'
        marker.write_text('preserve')
        with self.assertRaises(ValueError):
            archive_extract.extract(self.zip, self.target)
        self.assertEqual(marker.read_text(), 'preserve')
        alias = self.base/'alias'
        alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'aliases'):
            archive_extract.extract(self.zip, alias/'new')
        self.assertFalse((self.base/'new').exists())


if __name__ == '__main__':
    unittest.main()

import contextlib
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

SPEC = importlib.util.spec_from_file_location(
    'country_proxy_package', Path(__file__).resolve().parents[1] / 'scripts/package.py')
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in package.ROOT_FILES:
            (self.root / name).write_text('fixture for ' + name + '\n')
        for name in package.SOURCE_DIRS:
            (self.root / name).mkdir()
        (self.root / 'extension/manifest.json').write_text('{"version":"0.2.1"}\n')
        (self.root / '.github/workflows').mkdir()
        (self.root / '.github/workflows/checks.yml').write_text('name: Checks\n')
        (self.root / 'native/host.py').write_text('print("fixture")\n')

    def test_import_has_no_artifact_or_console_side_effects(self):
        imported = importlib.util.module_from_spec(SPEC)
        stdout = io.StringIO()
        with patch('zipfile.ZipFile', side_effect=AssertionError('Import must not build')):
            with contextlib.redirect_stdout(stdout):
                SPEC.loader.exec_module(imported)
        self.assertEqual(stdout.getvalue(), '')

    def test_reproducible_despite_local_metadata_and_creation_order(self):
        first = package.build(self.root).read_bytes()
        for path in package.source_files(self.root):
            data = path.read_bytes()
            path.unlink()
            path.write_bytes(data)
            os.utime(path, (1700000000, 1700000000))
            path.chmod(0o700)
        second = package.build(self.root).read_bytes()
        self.assertEqual(first, second)

    def test_manifest_hashes_checksum_modes_and_local_status(self):
        output = package.build(self.root)
        digest, filename = output.with_suffix('.zip.sha256').read_text().split()
        self.assertEqual(filename, output.name)
        self.assertEqual(digest, hashlib.sha256(output.read_bytes()).hexdigest())
        with ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read('country-proxy/BUILD-MANIFEST.json'))
            self.assertEqual(manifest['version'], '0.2.1')
            self.assertEqual(manifest['build_kind'], 'local-working-tree')
            self.assertFalse(manifest['release_verified'])
            names = {name.removeprefix('country-proxy/') for name in archive.namelist()}
            self.assertEqual(names - {'BUILD-MANIFEST.json'}, set(manifest['files']))
            for name, expected in manifest['files'].items():
                self.assertEqual(hashlib.sha256(archive.read('country-proxy/' + name)).hexdigest(), expected)
            for info in archive.infolist():
                self.assertEqual(info.date_time, package.FIXED_TIME)
                expected = 0o755 if info.filename.endswith('/Install.command') else 0o644
                self.assertEqual(stat.S_IMODE(info.external_attr >> 16), expected)
            self.assertIn('.github/workflows/checks.yml', names)
            self.assertIn('CHANGELOG.md', names)
            self.assertIn('CONTRIBUTING.md', names)

    def test_unlisted_roots_and_cache_files_are_excluded(self):
        for name in ('.runtime', '.venv', '.git', 'private-notes'):
            (self.root / name).mkdir()
            (self.root / name / 'private').write_text('must not ship')
        (self.root / '.env').write_text('must not ship')
        (self.root / 'native/__pycache__').mkdir()
        (self.root / 'native/__pycache__/cached.pyc').write_bytes(b'cache')
        (self.root / 'native/.DS_Store').write_bytes(b'cache')
        with ZipFile(package.build(self.root)) as archive:
            self.assertFalse(any('private' in name or '.pyc' in name or '.DS_Store' in name
                                 for name in archive.namelist()))

    def test_legal_and_dependency_locks_ship_exact_bytes_and_manifest_hashes(self):
        expected = {'LICENSE': b'MIT License\r\n\r\nCopyright (c) 2026 Fixture\r\n',
                    'NOTICE': 'Third-party notices\nТочный текст.\n'.encode(),
                    'requirements.txt': b'fixture-runtime==1.0 --hash=sha256:fixture\n',
                    'build-requirements.txt': b'fixture-build==1.0 --hash=sha256:fixture\n'}
        for name, body in expected.items():
            (self.root / name).write_bytes(body)
        with ZipFile(package.build(self.root)) as archive:
            manifest = json.loads(archive.read('country-proxy/BUILD-MANIFEST.json'))
            for name, body in expected.items():
                with self.subTest(name=name):
                    self.assertEqual(archive.read('country-proxy/' + name), body)
                    self.assertEqual(manifest['files'][name], hashlib.sha256(body).hexdigest())

    def test_missing_legal_file_fails_before_creating_artifact(self):
        for name in ('LICENSE', 'NOTICE', 'requirements.txt', 'build-requirements.txt'):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes() if path.exists() else None
                path.unlink(missing_ok=True)
                with self.assertRaises(FileNotFoundError):
                    package.build(self.root)
                self.assertFalse((self.root / 'dist').exists())
                if original is not None:
                    path.write_bytes(original)

    def test_symlink_legal_file_is_rejected_without_reading_target(self):
        target = self.root / 'README.md'
        original_target = target.read_bytes()
        for name in ('LICENSE', 'NOTICE', 'requirements.txt', 'build-requirements.txt'):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes() if path.exists() else None
                path.unlink(missing_ok=True)
                path.symlink_to(target)
                with patch.object(package, 'read_regular', side_effect=AssertionError('Must reject before reading')) as read:
                    with self.assertRaisesRegex(ValueError, 'Symlink'):
                        package.build(self.root)
                    read.assert_not_called()
                self.assertFalse((self.root / 'dist').exists())
                self.assertEqual(target.read_bytes(), original_target)
                path.unlink()
                if original is not None:
                    path.write_bytes(original)

    def test_rejects_symlink_files_directories_and_dangling_links(self):
        for target in ('README.md', 'native', 'missing'):
            link = self.root / 'docs/linked'
            link.symlink_to(self.root / target)
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'Symlink'):
                package.build(self.root)
            link.unlink()
        (self.root / 'config').rmdir()
        (self.root / 'config').symlink_to(self.root / 'native', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            package.build(self.root)

    def test_rejects_private_or_runtime_paths_inside_allowed_directories(self):
        for name in ('.runtime', '.venv', '.git', '.env', '.env.local', '.env-production', 'credentials.json',
                     'secrets.json', 'private.key', 'backup.kdbx', 'local.json',
                     'endpoint-history.json', 'endpoint-history.lock', '.endpoint-history-stale.tmp'):
            path = self.root / 'config' / name
            path.write_text('must not ship')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Private or runtime'):
                package.build(self.root)
            path.unlink()
        (self.root / 'docs/.git').mkdir()
        with self.assertRaisesRegex(ValueError, 'Private or runtime'):
            package.build(self.root)

    def test_invalid_version_fails_before_creating_artifact(self):
        (self.root / 'extension/manifest.json').write_text('{"version":"../../escape"}')
        with self.assertRaisesRegex(ValueError, 'version'):
            package.build(self.root)
        self.assertFalse((self.root / 'dist').exists())

    def test_release_version_obeys_project_and_chrome_bounds(self):
        for value in ('0.0.1', '0.2.1', '1.0.0', '65535.65535.65535'):
            self.assertEqual(package.release_version(value), value)
        for value in ('0.0.0', '00.2.1', '0.02.1', '0.2', '0.2.1.0', '0.2.65536',
                      '0.2.1-rc.1', '１.2.3', '0.2.1\n', None, 1):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'version'):
                package.release_version(value)

    def test_existing_hardlinked_zip_and_checksum_are_replaced_without_modifying_other_links(self):
        destination = self.root/'dist'
        destination.mkdir()
        output = destination/'country-proxy-0.2.1.zip'
        checksum = output.with_suffix('.zip.sha256')
        foreign_zip = self.root/'README.md'
        foreign_checksum = self.root/'NOTICE'
        before = {path:path.read_bytes() for path in (foreign_zip, foreign_checksum)}
        os.link(foreign_zip, output)
        os.link(foreign_checksum, checksum)
        package.build(self.root)
        for path, body in before.items():
            self.assertEqual(path.read_bytes(), body)
        self.assertNotEqual(output.stat().st_ino, foreign_zip.stat().st_ino)
        self.assertNotEqual(checksum.stat().st_ino, foreign_checksum.stat().st_ino)
        with ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
        self.assertEqual(checksum.read_text().split()[0], hashlib.sha256(output.read_bytes()).hexdigest())

    def test_output_symlink_is_rejected(self):
        (self.root / 'dist').mkdir()
        target = self.root / 'README.md'
        original = target.read_bytes()
        (self.root / 'dist/country-proxy-0.2.1.zip').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'output'):
            package.build(self.root)
        self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('country_proxy_install', Path(__file__).resolve().parents[1]/'scripts/install.py')
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()/'app'
        self.root.mkdir()
        (self.root/'extension').mkdir()
        (self.root/'extension/manifest.json').write_text('{"key":"dGVzdA=="}')
        (self.root/'.venv/bin').mkdir(parents=True)
        (self.root/'.venv/bin/python').touch()
        self.profile = self.root.parent/'profile'
        self.data = self.root.parent/'history'
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'native'))
        self.root_patch = patch.object(install, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.process = patch.object(install.subprocess, 'run')
        self.process.start()
        self.addCleanup(self.process.stop)

    def registered(self, profile=None):
        return json.loads(((profile or self.profile)/'NativeMessagingHosts/local.country_proxy.json').read_text())

    def test_custom_profile_requires_data_and_normal_default_is_installation_private(self):
        with self.assertRaisesRegex(ValueError, 'explicit --data-dir'):
            install.install(self.profile, False)
        self.assertFalse(self.profile.exists())
        with patch.object(install, 'profile_path', return_value=self.profile):
            install.install(None, False)
        wrapper = Path(self.registered()['path'])
        expected = self.root/'.runtime/data'/wrapper.name.removeprefix('host-')
        self.assertEqual(shlex.split(wrapper.read_text().splitlines()[1])[-2:], ['--data-dir', str(expected)])
        self.assertEqual(expected.stat().st_mode & 0o777, 0o700)

    def test_default_data_parent_symlink_is_rejected_without_chmod(self):
        runtime = self.root/'.runtime'
        runtime.mkdir(mode=0o700)
        target = self.root.parent/'unrelated'
        target.mkdir(mode=0o755)
        (runtime/'data').symlink_to(target, target_is_directory=True)
        with patch.object(install, 'profile_path', return_value=self.profile):
            with self.assertRaises((ValueError, OSError)):
                install.install(None, False)
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertEqual(list(target.iterdir()), [])

    def test_profiles_get_distinct_quoted_launchers(self):
        install.install(self.profile, False, self.data)
        first = Path(self.registered()['path'])
        before = first.read_bytes()
        second_profile = self.root.parent/"profile two ' quoted"
        install.install(second_profile, False, self.root.parent/'other-history')
        second = Path(self.registered(second_profile)['path'])
        self.assertNotEqual(first, second)
        self.assertEqual(before, first.read_bytes())
        self.assertEqual(first.name, 'host-'+hashlib.sha256(os.fsencode(self.profile)).hexdigest())
        self.assertEqual(shlex.split(first.read_text().splitlines()[1])[-2:], ['--data-dir', str(self.data)])
        self.assertEqual(first.stat().st_mode & 0o777, 0o700)

    def test_same_path_legacy_migration_and_prepared_rollback(self):
        install.install(self.profile, False, self.data)
        target = self.profile/'NativeMessagingHosts/local.country_proxy.json'
        manifest = self.registered()
        manifest['path'] = str(self.root/'.runtime/host')
        target.write_text(json.dumps(manifest))
        install.install(self.profile, False, self.data)
        self.assertEqual(self.registered()['path'], str(install.launcher_path(self.profile)))
        install.install(self.profile, False, prepare_legacy_rollback=True)
        self.assertEqual(self.registered()['path'], str(self.root/'.runtime/host'))
        self.assertNotIn('--data-dir', (self.root/'.runtime/host').read_text())
        # This is exactly the previous installer's same-install path condition.
        self.assertEqual(json.loads(target.read_text())['path'], str(self.root/'.runtime/host'))

    def test_foreign_registration_and_changed_registration_are_preserved(self):
        install.install(self.profile, False, self.data)
        target = self.profile/'NativeMessagingHosts/local.country_proxy.json'
        manifest = self.registered()
        manifest['path'] = '/some/other/install/.runtime/host'
        target.write_text(json.dumps(manifest))
        before = target.read_bytes()
        with self.assertRaisesRegex(ValueError, 'зарегистрирован'):
            install.install(self.profile, False, self.data)
        self.assertEqual(target.read_bytes(), before)
        target.unlink()
        install.install(self.profile, False, self.data)
        original_atomic = install.atomic_write
        def racing_write(path, data, mode):
            original_atomic(path, data, mode)
            if path.name.startswith('host-'):
                target.write_bytes(b'{"concurrent":"registration"}')
        with patch.object(install, 'atomic_write', side_effect=racing_write):
            with self.assertRaisesRegex(ValueError, 'changed'):
                install.install(self.profile, False, self.data)
        self.assertEqual(target.read_bytes(), b'{"concurrent":"registration"}')

    def test_registration_symlink_is_not_read_or_overwritten(self):
        directory = self.profile/'NativeMessagingHosts'
        directory.mkdir(parents=True)
        victim = self.root/'victim'
        victim.write_text('private')
        (directory/'local.country_proxy.json').symlink_to(victim)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            install.install(self.profile, False, self.data)
        self.assertEqual(victim.read_text(), 'private')


if __name__ == '__main__':
    unittest.main()

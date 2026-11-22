import hashlib
import importlib.util
import json
import os
import re
import subprocess
import shutil
import venv
from zipfile import ZipFile
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

REAL_RUN = subprocess.run

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
        venv.EnvBuilder(with_pip=False, symlinks=True).create(self.root/'.venv')
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

    def test_venv_and_bin_aliases_are_rejected_before_any_child_or_environment_creation(self):
        for relative in ('.venv', '.venv/bin'):
            with self.subTest(relative=relative):
                path = self.root/relative
                foreign = self.root.parent/('foreign-'+path.name)
                path.rename(foreign)
                path.symlink_to(foreign, target_is_directory=True)
                before = {str(p.relative_to(foreign)):p.read_bytes() for p in foreign.rglob('*') if p.is_file()}
                with patch.object(install.venv.EnvBuilder, 'create') as create:
                    with self.assertRaisesRegex(ValueError, 'Unsafe venv'):
                        install.install(self.profile, True, self.data)
                    create.assert_not_called()
                install.subprocess.run.assert_not_called()
                self.assertEqual(before, {str(p.relative_to(foreign)):p.read_bytes() for p in foreign.rglob('*') if p.is_file()})
                path.unlink()
                foreign.rename(path)

    def test_venv_library_directory_alias_cannot_redirect_pip_writes(self):
        foreign = self.root.parent/'foreign-library'
        foreign.mkdir()
        marker = foreign/'preserve'
        marker.write_bytes(b'untouched')
        shutil.rmtree(self.root/'.venv/lib')
        (self.root/'.venv/lib').symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Unsafe venv'):
            install.install(self.profile, True, self.data)
        install.subprocess.run.assert_not_called()
        self.assertEqual(marker.read_bytes(), b'untouched')
        self.assertEqual(list(foreign.iterdir()), [marker])

    def test_normal_venv_python_symlink_to_base_interpreter_is_preserved(self):
        python = self.root/'.venv/bin/python'
        python.unlink()
        python.symlink_to(sys.executable)
        install.install(self.profile, False, self.data)
        self.assertTrue(python.is_symlink())
        self.assertEqual(python.readlink(), Path(sys.executable))
        self.assertEqual(self.registered()['path'], str(install.launcher_path(self.profile)))

    def test_venv_config_missing_linked_or_system_enabled_fails_before_children(self):
        config = self.root/'.venv/pyvenv.cfg'
        original = config.read_bytes()
        foreign = self.root.parent/'foreign-config'
        foreign.write_bytes(original)
        for mutation in ('missing', 'linked', 'system-enabled'):
            with self.subTest(mutation=mutation):
                config.unlink()
                if mutation == 'linked':
                    config.symlink_to(foreign)
                elif mutation == 'system-enabled':
                    config.write_text('include-system-site-packages = true\n')
                with self.assertRaisesRegex(ValueError, 'Unsafe venv'):
                    install.install(self.profile, True, self.data)
                install.subprocess.run.assert_not_called()
                self.assertEqual(foreign.read_bytes(), original)
                config.unlink(missing_ok=True)
                config.write_bytes(original)

    def test_partial_nonempty_venv_never_runs_envbuilder_or_overwrites_links(self):
        python = self.root/'.venv/bin/python'
        python.unlink()
        config = self.root/'.venv/pyvenv.cfg'
        config.unlink()
        foreign = self.root.parent/'foreign-partial'
        foreign.write_bytes(b'preserved external bytes')
        config.symlink_to(foreign)
        with patch.object(install.venv.EnvBuilder, 'create') as create:
            with self.assertRaisesRegex(ValueError, 'Unsafe venv'):
                install.install(self.profile, True, self.data)
            create.assert_not_called()
        install.subprocess.run.assert_not_called()
        self.assertEqual(foreign.read_bytes(), b'preserved external bytes')

    def test_actual_base_interpreter_wrapper_is_rejected_before_pip(self):
        python = self.root/'.venv/bin/python'
        python.unlink()
        python.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' "$@"\n')
        python.chmod(0o755)
        with patch.object(install.subprocess, 'run', side_effect=REAL_RUN) as run:
            with self.assertRaisesRegex(ValueError, 'Unsafe venv'):
                install.install(self.profile, True, self.data)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn('pip', run.call_args.args[0])
        self.assertFalse(self.profile.exists())

    def test_real_ordinary_venv_prefix_and_base_interpreter_link_pass(self):
        with patch.object(install.subprocess, 'run', side_effect=REAL_RUN):
            self.assertTrue(install.checked_venv(require_python=True))
        self.assertTrue((self.root/'.venv/bin/python').is_symlink())

    def test_registration_parent_alias_is_rejected_before_dependencies_and_writes(self):
        self.profile.mkdir()
        foreign = self.root.parent/'foreign-registration-directory'
        foreign.mkdir()
        marker = foreign/'preserve'
        marker.write_bytes(b'foreign registration directory')
        (self.profile/'NativeMessagingHosts').symlink_to(foreign, target_is_directory=True)
        with patch.object(install, 'install_dependencies') as dependencies:
            with self.assertRaisesRegex(ValueError, 'registration directory'):
                install.install(self.profile, True, self.data)
            dependencies.assert_not_called()
        self.assertEqual(list(foreign.iterdir()), [marker])
        self.assertEqual(marker.read_bytes(), b'foreign registration directory')


class DependencyInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runtime = self.root/'.runtime'
        self.runtime.mkdir(mode=0o700)
        self.python = self.root/'.venv/bin/python'
        self.python.parent.mkdir(parents=True)
        self.python.touch()
        (self.root/'.venv/pyvenv.cfg').write_text('include-system-site-packages = false\n')
        self.patch = patch.object(install, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        (self.root/'requirements.txt').write_text('demo==1.0 --hash=sha256:'+'a'*64+'\nsource @ https://example.invalid/source.zip#sha256='+'b'*64+' --hash=sha256:'+'b'*64+'\n')
        (self.root/'build-requirements.txt').write_text('setuptools==84.2.1 --hash=sha256:'+'c'*64+'\n')

    def fake_wheels(self, command, **kwargs):
        if '--wheel-dir' in command:
            directory = Path(command[command.index('--wheel-dir')+1])
            directory.mkdir()
            for name in ('demo', 'source'):
                with ZipFile(directory/(name+'-1.0-py3-none-any.whl'), 'w') as archive:
                    archive.writestr(name+'-1.0.dist-info/METADATA', 'Name: '+name+'\nVersion: 1.0\n')
        return subprocess.CompletedProcess(command, 0)

    def test_hash_locked_build_and_runtime_use_separate_venvs_and_no_index_install(self):
        with patch.object(install.subprocess, 'run', side_effect=self.fake_wheels) as run:
            install.install_dependencies(self.python, self.runtime)
        commands = [c.args[0] for c in run.call_args_list]
        downloads = [c for c in commands if '--index-url' in c]
        self.assertEqual(len(downloads), 2)
        for command in downloads:
            self.assertIn('--require-hashes', command)
            self.assertIn('--only-binary=:all:', command)
            self.assertIn('--no-deps', command)
            self.assertNotEqual(command[0], str(self.python))
        wheel = next(c for c in commands if 'wheel' in c)
        self.assertIn('--no-build-isolation', wheel)
        runtime_install = next(c for c in commands if 'install' in c and c[0] == str(self.python))
        self.assertIn('--no-index', runtime_install)
        self.assertIn('--force-reinstall', runtime_install)
        self.assertIn('--require-hashes', runtime_install)
        self.assertIn('--no-deps', runtime_install)
        self.assertTrue(any(c[-1] == 'check' for c in commands))
        for call in run.call_args_list:
            self.assertEqual(call.kwargs['env']['PIP_CONFIG_FILE'], os.devnull)
        receipt = json.loads((self.runtime/'dependency-install.json').read_text())
        self.assertEqual(receipt['requirementsSHA256'], hashlib.sha256((self.root/'requirements.txt').read_bytes()).hexdigest())
        self.assertEqual(receipt['sourceArchiveSHA256'], 'b'*64)
        self.assertEqual(receipt['distributions'], {'demo':'1.0', 'source':'1.0'})
        self.assertEqual((self.runtime/'dependency-install.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.runtime.iterdir()), [self.runtime/'dependency-install.json'])

    def test_hostile_pip_and_python_environment_cannot_override_inputs(self):
        with patch.dict(os.environ, {'PIP_INDEX_URL':'https://example.invalid/',
                                     'PIP_EXTRA_INDEX_URL':'https://example.invalid/extra',
                                     'PIP_CONFIG_FILE':'/do-not-read/pip.conf',
                                     'PYTHONPATH':'/do-not-import', 'PYTHONHOME':'/do-not-use'}):
            env = install.pip_environment(self.root)
        self.assertEqual({k:v for k,v in env.items() if k.startswith('PIP_')}, {'PIP_CONFIG_FILE':os.devnull})
        self.assertFalse(any(k.startswith('PYTHON') for k in env))
        self.assertIn('-I', install.pip_command(self.python))
        self.assertIn('--isolated', install.pip_command(self.python))

    def test_build_failure_cleans_temporary_env_and_never_installs_runtime(self):
        def fail(command, **kwargs):
            if '--wheel-dir' in command:
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 0)
        with patch.object(install.subprocess, 'run', side_effect=fail) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                install.install_dependencies(self.python, self.runtime)
        self.assertFalse(any('install' in c.args[0] and c.args[0][0] == str(self.python) for c in run.call_args_list))
        self.assertEqual(list(self.runtime.iterdir()), [])

    def test_existing_venv_foreign_packages_fail_before_download(self):
        with patch.object(install.subprocess, 'run', side_effect=[subprocess.CompletedProcess('prefix-check', 0), subprocess.CalledProcessError(1, 'foreign')]) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                install.install_dependencies(self.python, self.runtime)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(list(self.runtime.iterdir()), [])


class DependencyLockTests(unittest.TestCase):
    def test_all_runtime_and_build_requirements_have_exact_sha256_pins(self):
        root = Path(__file__).resolve().parents[1]
        for filename in ('requirements.txt', 'build-requirements.txt'):
            for line in (root/filename).read_text().splitlines():
                if not line or line.startswith('#'):
                    continue
                with self.subTest(filename=filename, requirement=line):
                    self.assertRegex(line, r' --hash=sha256:[0-9a-f]{64}$')
                    self.assertTrue('==' in line or re.search(r' @ https://github\.com/.*/archive/[0-9a-f]{40}\.zip#sha256=[0-9a-f]{64}', line))

    def test_real_pip_ignores_hostile_config_and_rejects_tampered_wheel_offline(self):
        import venv
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            python = base/'venv/bin/python'
            venv.EnvBuilder(with_pip=True).create(base/'venv')
            wheel = base/'locked_fixture-1.0-py3-none-any.whl'
            with ZipFile(wheel, 'w') as archive:
                archive.writestr('locked_fixture.py', 'VALUE = 1\n')
                archive.writestr('locked_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: locked-fixture\nVersion: 1.0\n')
                archive.writestr('locked_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
                archive.writestr('locked_fixture-1.0.dist-info/RECORD', '')
            digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
            lock = base/'requirements.txt'
            lock.write_text(f'locked-fixture @ {wheel.as_uri()} --hash=sha256:{digest}\n')
            config = base/'hostile-pip.conf'
            unexpected = base/'unexpected-target'
            config.write_text('[global]\nindex-url = https://example.invalid/never-contact\n[install]\ntarget = '+str(unexpected)+'\n')
            with patch.dict(os.environ, {'PIP_CONFIG_FILE':str(config), 'PIP_TARGET':str(unexpected),
                                         'PIP_EXTRA_INDEX_URL':'https://example.invalid/never-contact'}):
                env = install.pip_environment(base)
            command = install.pip_command(python) + ['install', '--no-index', '--no-deps', '--require-hashes', '--force-reinstall', '-r', str(lock)]
            clean = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(clean.returncode, 0, clean.stdout+clean.stderr)
            self.assertFalse(unexpected.exists(), 'Inherited config changed the install destination')
            verify = subprocess.run([str(python), '-I', '-c', 'import locked_fixture; assert locked_fixture.VALUE == 1'], capture_output=True, text=True)
            self.assertEqual(verify.returncode, 0, verify.stderr)
            with wheel.open('ab') as stream:
                stream.write(b'tampered distribution')
            corrupt = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(corrupt.returncode, 0)
            self.assertIn('DO NOT MATCH THE HASHES', corrupt.stdout+corrupt.stderr)
            self.assertFalse(unexpected.exists())



if __name__ == '__main__':
    unittest.main()

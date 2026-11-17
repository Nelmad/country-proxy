"""Install.command argument/selection contract; all installers/interpreters are fakes."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get('CP_INSTALL_COMMAND_SOURCE', ROOT / 'Install.command')).resolve()


class InstallCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cp-install-command-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.bin = self.directory / 'bin'
        self.bin.mkdir()
        self.app = self.directory / "new user ' app"
        (self.app / 'scripts').mkdir(parents=True)
        # Adapt only the two fixed interpreter locations. The version selection,
        # argument forwarding, shell quoting and installer invocation stay exact.
        source = SOURCE.read_text()
        for absolute, local in [('/opt/homebrew/bin/python3', 'homebrew-python3'),
                                ('/usr/local/bin/python3', 'local-python3')]:
            self.assertEqual(source.count(absolute), 1)
            source = source.replace(absolute, str(self.bin / local))
        self.command = self.app / 'Install.command'
        self.command.write_text(source)
        self.command.chmod(0o700)
        (self.app / 'scripts/install.py').write_text('''import argparse,json,sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--profile')
p.add_argument('--data-dir')
p.add_argument('--skip-dependencies',action='store_true')
args=p.parse_args()
if args.profile is not None and args.data_dir is None:
    p.error('explicit profile requires explicit data-dir')
Path('invocation.json').write_text(json.dumps({'argv':sys.argv[1:],'profile':args.profile,'dataDir':args.data_dir}))
if args.profile is None:
    Path('default-registration').write_text('test fixture only')
''')
        for name in ('homebrew-python3', 'local-python3', 'python3',
                     'python3.14', 'python3.13', 'python3.12', 'python3.11'):
            self.interpreter(name, compatible=name == 'python3')

    def interpreter(self, name, *, compatible):
        # A compatible fake forwards to a stub Python file, never real install.py.
        path = self.bin / name
        path.write_text('#!/bin/sh\nif [ "$1" = "-c" ]; then exit ' + ('0' if compatible else '1') + '; fi\n'
                        + 'exec ' + shlex.quote(sys.executable) + ' "$@"\n')
        path.chmod(0o700)

    def run_wrapper(self, *arguments):
        environment = dict(os.environ)
        environment['PATH'] = str(self.bin) + ':/usr/bin:/bin'
        # HOME is inherited unchanged. Every fake writes only below this fixture.
        return subprocess.run(['/bin/sh', str(self.command), *arguments], cwd=self.directory,
                              env=environment, capture_output=True, text=True, timeout=10)

    def invocation(self):
        return json.loads((self.app / 'invocation.json').read_text())

    def test_custom_profile_and_data_dir_are_forwarded_without_default_registration(self):
        arguments = ['--profile', str(self.directory / 'temporary chrome root'),
                     '--data-dir', str(self.directory / "private history ' quoted")]
        result = self.run_wrapper(*arguments)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.invocation()['argv'], arguments)
        self.assertFalse((self.app / 'default-registration').exists())

    def test_argument_shell_metacharacters_remain_literal(self):
        profile = "profile ' ; touch SHOULD_NOT_EXIST ; $(touch ALSO_SHOULD_NOT_EXIST)"
        data = 'history with spaces\nand a newline'
        result = self.run_wrapper('--profile', profile, '--data-dir', data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.invocation()['profile'], profile)
        self.assertEqual(self.invocation()['dataDir'], data)
        self.assertFalse((self.app / 'SHOULD_NOT_EXIST').exists())
        self.assertFalse((self.app / 'ALSO_SHOULD_NOT_EXIST').exists())

    def test_unknown_option_is_an_installer_error_not_successful_default_install(self):
        result = self.run_wrapper('--unknown-install-option')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.app / 'invocation.json').exists())
        self.assertFalse((self.app / 'default-registration').exists())
        self.assertNotIn('Откройте chrome://extensions', result.stdout)

    def test_incomplete_explicit_profile_cannot_fall_back_to_default(self):
        result = self.run_wrapper('--profile', 'temporary-profile')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.app / 'invocation.json').exists())
        self.assertFalse((self.app / 'default-registration').exists())

    def test_each_supported_versioned_name_is_reachable_after_old_generic_python(self):
        self.interpreter('python3', compatible=False)
        for name in ('python3.14', 'python3.13', 'python3.12', 'python3.11'):
            with self.subTest(name=name):
                self.interpreter(name, compatible=True)
                result = self.run_wrapper('--profile', 'temporary-profile', '--data-dir', 'private-history')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.invocation()['profile'], 'temporary-profile')
                self.assertFalse((self.app / 'default-registration').exists())
                self.interpreter(name, compatible=False)
                (self.app / 'invocation.json').unlink()

    def test_no_compatible_python_fails_before_installer(self):
        self.interpreter('python3', compatible=False)
        result = self.run_wrapper('--profile', 'temporary-profile', '--data-dir', 'private-history')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Python 3.11+', result.stdout)
        self.assertFalse((self.app / 'invocation.json').exists())
        self.assertFalse((self.app / 'default-registration').exists())

    def test_ordinary_no_argument_path_is_preserved(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.invocation()['argv'], [])
        self.assertTrue((self.app / 'default-registration').exists())


if __name__ == '__main__':
    unittest.main()

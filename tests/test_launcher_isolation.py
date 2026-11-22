"""Behavioral Python isolation at the installed shell-launcher boundary.

The generated launcher, owned venv interpreter, framing, and native host are
real. Only the installer's dependency-presence smoke is bypassed: hello/Stop
uses stdlib and local modules, so this offline regression needs no packages.
This does not exercise discovery, proxy checks, or a Chrome installation.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('launcher_isolation_install', ROOT/'scripts/install.py')
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


@unittest.skipUnless(sys.platform in ('darwin', 'linux'), 'POSIX launcher contract')
class LauncherIsolationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='country-proxy-launcher-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        # Spaces and apostrophes also exercise the generated shell's quoting.
        self.app = self.directory/"owned app ' quoted"
        self.app.mkdir()
        shutil.copytree(ROOT/'native', self.app/'native',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (self.app/'extension').mkdir()
        for name in ('manifest.json', 'countries.json'):
            shutil.copyfile(ROOT/'extension'/name, self.app/'extension'/name)
        self.python = self.app/'.venv/bin/python'
        subprocess.run([sys.executable, '-I', '-B', '-m', 'venv', '--without-pip',
                        str(self.app/'.venv')], check=True, capture_output=True, timeout=15)
        self.profile = self.directory/"owned profile ' quoted"
        self.data = self.directory/"owned history ' quoted"
        original_path = sys.path[:]
        self.addCleanup(sys.path.__setitem__, slice(None), original_path)
        real_run = subprocess.run
        smoke = [str(self.python), '-I', '-c', 'import proxyscraper, certifi']
        skipped_smoke = []

        def run_install_check(command, **kwargs):
            if command == smoke:
                skipped_smoke.append(command)
                return subprocess.CompletedProcess(command, 0)
            # Run the actual venv identity/prefix/user-site safety checks, with
            # a bound even if an interpreter fails to terminate.
            return real_run(command, timeout=15, **kwargs)

        with patch.object(install, 'ROOT', self.app), \
                patch.object(install.subprocess, 'run', side_effect=run_install_check), \
                contextlib.redirect_stdout(io.StringIO()):
            install.install(self.profile, dependencies=False, data_dir=self.data)
        self.assertEqual(len(skipped_smoke), 1, 'Only dependency-presence smoke may be bypassed')
        registration = json.loads((self.profile/'NativeMessagingHosts/local.country_proxy.json').read_text())
        self.launcher = Path(registration['path'])
        self.assertTrue(self.launcher.is_relative_to(self.app/'.runtime'))
        self.marker = self.directory/'ambient-sitecustomize-ran'
        ambient = self.directory/'ambient-python-path'
        ambient.mkdir()
        (ambient/'sitecustomize.py').write_text(
            'from pathlib import Path\n'
            'Path(' + repr(str(self.marker)) + ').write_text("ambient code executed\\n")\n')
        # Child-only environment: do not mutate os.environ or inherit unrelated
        # Python overrides that could make the positive control fail to start.
        self.environment = {key: value for key, value in os.environ.items()
                            if not key.startswith('PYTHON')}
        self.environment['PYTHONPATH'] = str(ambient)

    def run_host(self, launcher):
        body = b'{"command":"stop"}'
        result = subprocess.run([str(launcher)], env=self.environment, cwd=self.directory,
                                input=struct.pack('=I', len(body)) + body,
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        self.assertEqual(result.stderr, b'')
        messages, remaining = [], result.stdout
        while remaining:
            self.assertGreaterEqual(len(remaining), 4, 'Truncated native frame header')
            size = struct.unpack('=I', remaining[:4])[0]
            self.assertGreaterEqual(size, 2)
            self.assertLessEqual(size, 65536)
            self.assertGreaterEqual(len(remaining) - 4, size, 'Truncated native frame payload')
            messages.append(json.loads(remaining[4:4 + size]))
            remaining = remaining[4 + size:]
        self.assertEqual(len(messages), 2, messages)
        hello, stopped = messages
        self.assertEqual(hello['type'], 'hello')
        self.assertEqual(hello['history'], {'mode': 'persistent', 'records': 0})
        self.assertEqual(hello['feedbackProtocol'], 1)
        self.assertEqual(hello['version'], json.loads((ROOT/'extension/manifest.json').read_text())['version'])
        self.assertEqual(stopped, {'type': 'stopped'})

    def test_generated_launcher_ignores_ambient_pythonpath_and_starts_real_host(self):
        self.run_host(self.launcher)
        self.assertFalse(self.marker.exists(), 'Ambient PYTHONPATH/sitecustomize executed through launcher')

    def test_positive_control_without_isolation_executes_ambient_sitecustomize(self):
        # Mutate an owned copy of the generated shell, never installer source.
        # A successful real hello plus the marker proves this injection is live;
        # the production negative assertion cannot pass due to a dead fixture.
        command = shlex.split(self.launcher.read_text().splitlines()[1])
        self.assertEqual(command.pop(0), 'exec')
        if '-I' in command:
            command.remove('-I')
        mutant = self.launcher.parent/'owned-positive-control-without-isolation'
        mutant.write_text('#!/bin/sh\nexec ' + shlex.join(command) + '\n')
        mutant.chmod(0o700)
        self.run_host(mutant)
        self.assertTrue(self.marker.is_file(), 'Positive control did not execute ambient sitecustomize')
        self.assertEqual(self.marker.read_text(), 'ambient code executed\n')


if __name__ == '__main__':
    unittest.main()

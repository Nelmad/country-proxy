"""Real framed installed-launcher checks; isolated profiles, no Chrome or network."""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native'))
from core import Candidate
from history import EndpointHistory
from history_store import FileHistoryStore, HISTORY

RUNTIME_DISTRIBUTIONS = ('proxy-scraper-cli', 'certifi', 'rich', 'markdown-it-py', 'mdurl', 'Pygments')


def prepare_owned_venv(app, source_python, *, python=None, distributions=RUNTIME_DISTRIBUTIONS):
    """Create an actual owned venv and copy installed runtime packages offline.

    The explicit source interpreter is read-only. The locked runtime graph is
    pure Python and can be copied to TEST_PYTHON without downloading packages.
    Bin scripts and pip are unnecessary; no source directories are linked.
    """
    target = app/'.venv'
    subprocess.run([str(python or source_python), '-I', '-B', '-m', 'venv', '--without-pip', str(target)],
                   check=True, capture_output=True, text=True, timeout=30)
    code = '''import importlib.metadata as m,json,pathlib,sys
rows=[]
for name in sys.argv[1:]:
 d=m.distribution(name)
 for f in d.files or ():
  if f.is_absolute() or '..' in f.parts or f.suffix=='.pyc':continue
  source=pathlib.Path(d.locate_file(f))
  if source.is_file():rows.append([str(source),str(f)])
print(json.dumps(rows))
'''
    files = json.loads(subprocess.run([str(source_python), '-I', '-B', '-c', code, *distributions],
                                     check=True, capture_output=True, text=True, timeout=15).stdout)
    packages = Path(subprocess.run([str(target/'bin/python'), '-I', '-B', '-c',
                                   'import sysconfig;print(sysconfig.get_path("purelib"))'],
                                  check=True, capture_output=True, text=True, timeout=15).stdout.strip())
    assert packages.is_relative_to(target)
    for source, relative in files:
        destination = packages/relative
        assert destination.is_relative_to(packages)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return target


class InstalledLauncherTests(unittest.TestCase):
    def setUp(self):
        source_python = Path(os.environ.get('TEST_RUNTIME_PYTHON', str(ROOT/'.venv/bin/python')))
        self.assertTrue(source_python.is_absolute() and source_python.is_file(),
                        'Set TEST_RUNTIME_PYTHON to an already installed dependency interpreter; no downloads')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.app = self.directory/'installed-app'
        self.profile = self.directory/"isolated-profile ' quoted"
        self.data = self.directory/'private-history'
        self.copy_bundle(ROOT)
        python = Path(os.environ.get('TEST_PYTHON', str(source_python)))
        self.assertTrue(python.is_absolute() and python.is_file(), 'TEST_PYTHON must be an exact local interpreter')
        self.venv = prepare_owned_venv(self.app, source_python, python=python)
        self.assertFalse(self.venv.is_symlink())
        self.venv_identity = (self.venv.stat().st_ino, (self.venv/'pyvenv.cfg').read_bytes())
        self.children = []
        self.addCleanup(self.stop_children)

    def copy_bundle(self, source):
        self.app.mkdir(exist_ok=True)
        for name in ('native', 'extension', 'scripts'):
            target = self.app/name
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source/name, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))

    def installer(self, *, legacy=False, prepare=False):
        command = [str(self.venv/'bin/python'), '-I', '-B', str(self.app/'scripts/install.py'),
                   '--profile', str(self.profile), '--skip-dependencies']
        if prepare:
            command.append('--prepare-legacy-rollback')
        elif not legacy:
            command += ['--data-dir', str(self.data)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.venv.stat().st_ino, (self.venv/'pyvenv.cfg').read_bytes()), self.venv_identity)
        self.registration = json.loads((self.profile/'NativeMessagingHosts/local.country_proxy.json').read_text())
        return result

    def preload(self):
        history = EndpointHistory()
        history.seen(Candidate('http', '8.8.8.8', 8080), ('fixture',))
        store = FileHistoryStore(self.data)
        try:
            store.save(history.snapshot())
        finally:
            store.close()

    def launch(self):
        child = subprocess.Popen([self.registration['path']], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(child)
        hello = self.message(child)
        self.assertEqual(hello['type'], 'hello')
        return child, hello

    def exact(self, child, size):
        output = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            while len(output) < size:
                self.assertTrue(selector.select(5), 'Timed out waiting for native frame')
                chunk = os.read(child.stdout.fileno(), size-len(output))
                self.assertTrue(chunk, 'Native stdout closed before frame completed')
                output.extend(chunk)
            return bytes(output)
        finally:
            selector.close()

    def message(self, child):
        size = struct.unpack('=I', self.exact(child, 4))[0]
        self.assertLessEqual(size, 65536)
        return json.loads(self.exact(child, size))

    def stop(self, child):
        body = b'{"command":"stop"}'
        child.stdin.write(struct.pack('=I', len(body))+body)
        child.stdin.flush()
        self.assertEqual(self.message(child)['type'], 'stopped')
        child.stdin.close()
        self.assertEqual(child.wait(timeout=5), 0, child.stderr.read().decode())
        child.stdout.close()
        child.stderr.close()

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream and not stream.closed:
                    stream.close()

    def test_real_launcher_persistent_restart_busy_stop_sigterm_and_sigkill(self):
        self.installer()
        self.preload()
        first, hello = self.launch()
        self.assertEqual(hello['history'], {'mode':'persistent', 'records':1})
        second, hello = self.launch()
        self.assertEqual(hello['history'], {'mode':'busy', 'records':0})
        # A graceful signal closes the writer without requiring a browser command.
        first.send_signal(signal.SIGTERM)
        self.assertEqual(first.wait(timeout=5), 0, first.stderr.read().decode())
        self.stop(second)
        third, hello = self.launch()
        self.assertEqual(hello['history'], {'mode':'persistent', 'records':1})
        # The OS releases flock even if normal final flush cannot run.
        third.kill()
        self.assertEqual(third.wait(timeout=5), -signal.SIGKILL)
        fourth, hello = self.launch()
        self.assertEqual(hello['history'], {'mode':'persistent', 'records':1})
        self.stop(fourth)
        payload = json.loads((self.data/HISTORY).read_bytes())
        self.assertEqual(len(payload['records']), 1)
        self.assertFalse(any(p.suffix == '.tmp' for p in self.data.iterdir()))

    def test_real_new_previous_new_same_install_registration_and_cache(self):
        baseline = os.environ.get('TEST_BASELINE_ROOT')
        self.assertTrue(baseline, 'Set TEST_BASELINE_ROOT to the exact previous bundle')
        baseline = Path(baseline).resolve()
        self.assertTrue((baseline/'scripts/install.py').is_file())
        baseline_version = json.loads((baseline/'extension/manifest.json').read_text())['version']
        legacy = baseline_version == '0.2.0'
        self.installer()
        self.preload()
        first, hello = self.launch()
        self.assertEqual(hello['history']['records'], 1)
        self.stop(first)
        before = (self.data/HISTORY).read_bytes()
        if legacy:
            self.installer(prepare=True)
            self.assertEqual(self.registration['path'], str(self.app/'.runtime/host'))
        self.copy_bundle(baseline)
        self.installer(legacy=legacy)
        previous, hello = self.launch()
        self.assertEqual(hello['version'], baseline_version)
        if legacy:
            self.assertNotIn('history', hello)
        else:
            self.assertEqual(hello['history'], {'mode':'persistent', 'records':1})
        self.stop(previous)
        if legacy:
            self.assertEqual((self.data/HISTORY).read_bytes(), before)
        self.copy_bundle(ROOT)
        self.installer()
        restored, hello = self.launch()
        self.assertEqual(hello['history'], {'mode':'persistent', 'records':1})
        self.stop(restored)


if __name__ == '__main__':
    unittest.main()

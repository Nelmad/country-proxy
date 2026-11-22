"""Offline regressions for the actual explicit installation acceptance harnesses."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AcceptanceHarnessTests(unittest.TestCase):
    def test_actual_installed_fixture_venv_passes_installer_safety_gate(self):
        runtime = load('acceptance_runtime', ROOT/'tests/install-runtime.py')
        installer = load('acceptance_installer', ROOT/'scripts/install.py')
        builder = runtime.prepare_owned_venv
        fixture = runtime.InstalledLauncherTests()
        # Execute the actual fixture setup, omitting only third-party file copies.
        with patch.dict(os.environ, {'TEST_RUNTIME_PYTHON':sys.executable, 'TEST_PYTHON':sys.executable}), patch.object(
                runtime, 'prepare_owned_venv', side_effect=lambda *args, **kwargs: builder(*args, **kwargs, distributions=())):
            try:
                fixture.setUp()
                app = fixture.app
                self.assertFalse((app/'.venv').is_symlink())
                self.assertEqual((app/'.venv').stat().st_uid, os.getuid())
                with patch.object(installer, 'ROOT', app):
                    self.assertTrue(installer.checked_venv(require_python=True))
            finally:
                fixture.doCleanups()

    def test_exact_browser_acceptance_code_rejects_injected_failures(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Canonical checks require Node')
        result = subprocess.run([node, str(ROOT/'tests/acceptance-harness-regression.mjs')],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()

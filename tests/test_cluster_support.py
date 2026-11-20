"""Exercise startup in isolated processes without a sibling ATS checkout."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class TransportImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.monitor = self.root / 'opt' / 'api' / 'monitor'
        self.monitor.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'cluster_support.py',
                        self.monitor / 'cluster_support.py')
        (self.monitor / 'app.py').write_text("MARKER = 'monitor'\n")
        self.ats = self.root / 'separate ats'
        self.transport(self.ats, 'configured')

    def transport(self, path, marker):
        path.mkdir(parents=True, exist_ok=True)
        (path / 'ats_cluster.py').write_text(
            f'MAX_BODY = {marker!r}\nclass Store: pass\ndef remote(): pass\n')
        (path / 'app.py').write_text("raise RuntimeError('ATS app must not shadow Monitor')\n")
        return path

    def run_import(self, **settings):
        env = {k: v for k, v in os.environ.items()
               if k not in ('ATS_MODULE_DIR', 'ATS_CLI', 'PYTHONPATH')}
        env.update(settings)
        return subprocess.run(
            [sys.executable, '-I', '-c',
             'import sys; sys.path.insert(0, sys.argv[1]); '
             'import cluster_support; import app; assert app.MARKER == \"monitor\"; print(cluster_support.MAX_BODY)', str(self.monitor)],
            env=env, cwd=self.root, capture_output=True, text=True, timeout=10)

    def test_explicit_non_sibling_checkout(self):
        result = self.run_import(ATS_MODULE_DIR=str(self.ats))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'configured')

    def test_explicit_directory_overrides_cli(self):
        result = self.run_import(ATS_MODULE_DIR=str(self.ats), ATS_CLI='python3 /missing/app.py')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_absolute_cli_script_without_executing_command(self):
        result = self.run_import(ATS_CLI=f'sudo -n python3 "{self.ats}/app.py"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'configured')

    def test_sibling_checkout_compatibility(self):
        self.transport(self.monitor.parent / 'ats', 'sibling')
        result = self.run_import()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'sibling')

    def test_missing_explicit_path_does_not_fall_back(self):
        self.transport(self.monitor.parent / 'ats', 'wrong')
        result = self.run_import(ATS_MODULE_DIR=str(self.root / 'missing'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('directory containing ats_cluster.py', result.stderr)
        self.assertIn('not a PyPI requirement', result.stderr)

    def test_missing_cli_checkout_does_not_fall_back(self):
        self.transport(self.monitor.parent / 'ats', 'wrong')
        result = self.run_import(ATS_CLI='python3 /missing/app.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('set ATS_MODULE_DIR', result.stderr)

    def test_wrapper_relative_and_malformed_commands_require_configuration(self):
        for command in ('ats', 'python3 -m ats', 'python3 app.py', 'python3 "'):
            with self.subTest(command=command):
                result = self.run_import(ATS_CLI=command)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('ATS_MODULE_DIR', result.stderr)

    def test_dependency_import_errors_are_preserved(self):
        (self.ats / 'ats_cluster.py').write_text('import missing_internal_dependency\n')
        result = self.run_import(ATS_MODULE_DIR=str(self.ats))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing_internal_dependency', result.stderr)
        self.assertNotIn('transport is missing', result.stderr)


if __name__ == '__main__':
    unittest.main()

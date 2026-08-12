import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
APPLY_SCRIPT = REPO_ROOT / 'scripts' / 'apply-orchestrator-env.py'
VERIFY_SCRIPT = REPO_ROOT / 'scripts' / 'acs-verify-per-session.py'
TOOL_CONTENT_JSON = REPO_ROOT / 'scripts' / 'acs-tool-content-json.mjs'


def load_script(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'无法加载测试目标: {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ApplyOrchestratorEnvTest(unittest.TestCase):
    def test_syncs_declared_runtime_fields_and_preserves_runtime_only_fields(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            desired = root_path / 'desired.env'
            target = root_path / 'production.env'
            runtime = root_path / 'runtime.json'
            desired.write_text(
                'ACS_SANDBOX_CPU_LIMIT=2\n'
                'ACS_SANDBOX_MAX_RUNNING=200\n'
                'ACS_SANDBOX_WARN_RUNNING=150\n',
                encoding='utf-8',
            )
            target.write_text(
                'ACS_ORCH_AUTH_TOKEN=secret-token\n'
                f'ACS_ORCH_RUNTIME_CONFIG_FILE={runtime}\n'
                'ACS_SANDBOX_CPU_LIMIT=2\n'
                'ACS_SANDBOX_MAX_RUNNING=200\n'
                'ACS_SANDBOX_WARN_RUNNING=150\n',
                encoding='utf-8',
            )
            runtime.write_text(json.dumps({
                'maxRunningSandboxes': 24,
                'warnRunningSandboxes': 18,
                'drainDeadlineMs': 120_000,
                'egress': {'proxy': {'enabled': True, 'proxyUrl': 'http://proxy.internal'}},
            }), encoding='utf-8')

            result = subprocess.run(
                [sys.executable, str(APPLY_SCRIPT), '--desired', str(desired), '--target', str(target),
                 '--runtime-config-target', str(runtime)],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('env 待变更 0 项', result.stdout)
            self.assertIn('runtime config 待变更 2 项', result.stdout)
            target_text = target.read_text(encoding='utf-8')
            self.assertIn('ACS_ORCH_AUTH_TOKEN=secret-token', target_text)
            self.assertIn('ACS_SANDBOX_CPU_LIMIT=2', target_text)
            runtime_value = json.loads(runtime.read_text(encoding='utf-8'))
            self.assertEqual(runtime_value['maxRunningSandboxes'], 200)
            self.assertEqual(runtime_value['warnRunningSandboxes'], 150)
            self.assertEqual(runtime_value['drainDeadlineMs'], 120_000)
            self.assertTrue(runtime_value['egress']['proxy']['enabled'])

            second = subprocess.run(
                [sys.executable, str(APPLY_SCRIPT), '--desired', str(desired), '--target', str(target),
                 '--runtime-config-target', str(runtime), '--check'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn('均已与声明一致', second.stdout)


class AcsVerifyPerSessionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_script(VERIFY_SCRIPT, 'acs_verify_per_session')

    def test_runtime_scope_query_uses_existing_updated_at_column(self):
        sql = self.module.build_sql('2026-08-11 00:00', None)
        self.assertIn('r.updated_at DESC', sql)
        self.assertNotIn('r.created_at', sql)

    def test_formal_acceptance_requires_one_hundred_concurrent_samples(self):
        self.assertFalse(self.module.acceptance_sample_ready([1] * 5, [1] * 99))
        self.assertTrue(self.module.acceptance_sample_ready([1] * 5, [1] * 100))


class AcsToolContentJsonTest(unittest.TestCase):
    def parse(self, content: str):
        program = (
            "import { parseToolContentJson } from " + json.dumps(TOOL_CONTENT_JSON.as_uri()) + ";"
            "const response = JSON.parse(process.argv[1]);"
            "process.stdout.write(JSON.stringify(parseToolContentJson(response)));"
        )
        result = subprocess.run(
            ['node', '--input-type=module', '--eval', program, json.dumps({'content': content})],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_parses_raw_background_shell_json(self):
        self.assertEqual(self.parse('{"taskId":"task-1","status":"starting"}'), {
            'taskId': 'task-1',
            'status': 'starting',
        })

    def test_parses_json_from_formatted_shell_stdout(self):
        content = (
            'Exit code: 0\nWall time: 0.010s\nOutput bytes: stdout=32 stderr=0\n'
            'Output lines: stdout=1 stderr=0\n\n[stdout]\n'
            '{"status":"ready","alive":true}\n'
        )
        self.assertEqual(self.parse(content), {'status': 'ready', 'alive': True})


if __name__ == '__main__':
    unittest.main()

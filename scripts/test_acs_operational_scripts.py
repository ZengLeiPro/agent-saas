import importlib.util
import ipaddress
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
APPLY_SCRIPT = REPO_ROOT / 'scripts' / 'apply-orchestrator-env.py'
VERIFY_SCRIPT = REPO_ROOT / 'scripts' / 'acs-verify-per-session.py'
TOOL_CONTENT_JSON = REPO_ROOT / 'scripts' / 'acs-tool-content-json.mjs'
ACS_WORKFLOW = REPO_ROOT / '.github' / 'workflows' / 'acs-sandbox.yml'
ACS_CLASSIFIER = REPO_ROOT / '.github' / 'scripts' / 'acs-classify.sh'
ACS_DEPLOY_SCRIPT = REPO_ROOT / 'scripts' / 'deploy-acs-orchestrator.sh'
ACS_BROWSER_E2E = REPO_ROOT / 'scripts' / 'acs-browser-lease-e2e.mjs'
ACS_ROLLBACK_COMPATIBILITY = REPO_ROOT / 'scripts' / 'check-acs-shared-rollback-compatibility.mjs'
ACS_PRODUCTION_ENV = REPO_ROOT / 'acs-orchestrator' / 'config' / 'production.env'
ACS_STAGING_ENV = REPO_ROOT / 'acs-orchestrator' / 'config' / 'staging.env'
DOCKERFILE = REPO_ROOT / 'Dockerfile'


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

    def test_blank_tombstone_clears_renamed_env_without_deleting_runtime_secrets(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            desired = root_path / 'desired.env'
            target = root_path / 'production.env'
            desired.write_text(
                'ACS_SNAT_SHARED_CIDR=\n'
                'ACS_SNAT_SHARED_CIDRS=172.16.179.0/24,172.16.180.0/24\n',
                encoding='utf-8',
            )
            target.write_text(
                'ACS_ORCH_AUTH_TOKEN=secret-token\n'
                'ACS_SNAT_SHARED_CIDR=172.16.179.0/24\n',
                encoding='utf-8',
            )

            result = subprocess.run(
                [sys.executable, str(APPLY_SCRIPT), '--desired', str(desired), '--target', str(target)],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            target_text = target.read_text(encoding='utf-8')
            self.assertIn('ACS_ORCH_AUTH_TOKEN=secret-token', target_text)
            self.assertIn('ACS_SNAT_SHARED_CIDR=\n', target_text)
            self.assertIn('ACS_SNAT_SHARED_CIDRS=172.16.179.0/24,172.16.180.0/24', target_text)
            self.assertNotIn('ACS_SNAT_SHARED_CIDR=172.16.179.0/24', target_text)


class AcsSharedRollbackCompatibilityTest(unittest.TestCase):
    CIDRS = ['172.16.176.0/24', '172.18.191.0/24']

    def check(self, health_overrides=None, candidate_cidrs=None):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            env = '\n'.join([
                'ACS_SNAT_MODE=shared-cidr',
                'ACS_SNAT_REGION_ID=cn-shenzhen',
                'ACS_SNAT_TABLE_ID=stb-test',
                'ACS_SNAT_IP=120.77.218.94',
                f"ACS_SNAT_SHARED_CIDRS={','.join(self.CIDRS)}",
            ]) + '\n'
            candidate = env if candidate_cidrs is None else env.replace(
                ','.join(self.CIDRS), ','.join(candidate_cidrs))
            rollback_path = root_path / 'rollback.env'
            candidate_path = root_path / 'candidate.env'
            health_path = root_path / 'health.json'
            rollback_path.write_text(env, encoding='utf-8')
            candidate_path.write_text(candidate, encoding='utf-8')
            health = {
                'status': 'ok',
                'checks': {'snat': 'ok'},
                'snat': {
                    'mode': 'shared-cidr',
                    'regionId': 'cn-shenzhen',
                    'snatTableId': 'stb-test',
                    'snatIp': '120.77.218.94',
                    'sharedCidrs': self.CIDRS,
                    'sharedCidrAvailableCount': len(self.CIDRS),
                    'uncoveredPodCidrs': [],
                    'unexpectedCount': 0,
                    'sharedCidrConfigDigest': 'digest-1',
                },
            }
            for key, value in (health_overrides or {}).items():
                health['snat'][key] = value
            health_path.write_text(json.dumps(health), encoding='utf-8')
            return subprocess.run(
                ['node', str(ACS_ROLLBACK_COMPATIBILITY), str(health_path),
                 str(rollback_path), str(candidate_path)],
                text=True, capture_output=True, check=False,
                env={**os.environ, 'NODE_NO_WARNINGS': '1'},
            )

    def test_accepts_only_identical_healthy_shared_config(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['sharedCidrCount'], 2)

    def test_rejects_candidate_drift_or_incomplete_running_coverage(self):
        cases = [
            self.check(candidate_cidrs=['172.16.176.0/24']),
            self.check({'sharedCidrAvailableCount': 1}),
            self.check({'uncoveredPodCidrs': ['172.16.187.0/24']}),
            self.check({'unexpectedCount': 1}),
        ]
        for result in cases:
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(result.stderr)['compatible'])


class AcsDockerfileWorkspaceInjectionTest(unittest.TestCase):
    def test_copies_complete_shared_workspace_before_injected_install(self):
        dockerfile = DOCKERFILE.read_text(encoding='utf-8')
        acs_base = dockerfile.split(' AS acs-base', 1)[1].split('FROM acs-base AS acs-wheel-builder', 1)[0]

        shared_copy = acs_base.index('COPY shared ./shared')
        install = acs_base.index('RUN pnpm install --frozen-lockfile')
        self.assertLess(shared_copy, install)
        self.assertNotIn('COPY shared/package.json ./shared/', acs_base)


class AcsProductionSnatConfigTest(unittest.TestCase):
    def test_covers_complete_vswitch_pools_and_preserves_rollback_capacity(self):
        values = {}
        for line in ACS_PRODUCTION_ENV.read_text(encoding='utf-8').splitlines():
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key] = value

        expected = {
            str(subnet)
            for pool in ('172.16.176.0/20', '172.18.176.0/20')
            for subnet in ipaddress.ip_network(pool).subnets(new_prefix=24)
        }
        configured_list = values['ACS_SNAT_SHARED_CIDRS'].split(',')
        configured = set(configured_list)
        self.assertEqual(len(configured_list), len(configured), '生产 shared CIDR 不得重复')
        self.assertEqual(configured, expected)
        self.assertEqual(len(configured), 32)

        max_running = int(values['ACS_SANDBOX_MAX_RUNNING'])
        address_capacity = sum(ipaddress.ip_network(cidr).num_addresses for cidr in configured)
        self.assertEqual(max_running, 7_000)
        self.assertEqual(int(values['ACS_SANDBOX_TTL_MS']), 30 * 60_000)
        self.assertEqual(values['ACS_SANDBOX_LIFECYCLE_POLICY_MODE'], 'enforce')
        staging_env = ACS_STAGING_ENV.read_text(encoding='utf-8')
        self.assertIn('ACS_SANDBOX_LIFECYCLE_POLICY_MODE=enforce\n', staging_env)
        self.assertEqual(int(values['ACS_SANDBOX_MAX_ALLOCATED_CPU_MILLICORES']), 10_000_000)
        self.assertEqual(int(values['ACS_SANDBOX_MAX_ALLOCATED_MEMORY_MIB']), 20_000 * 1024)
        self.assertLessEqual(max_running, address_capacity)
        self.assertLess(int(values['ACS_SANDBOX_WARN_RUNNING']), max_running)
        self.assertLess(
            int(values['ACS_SANDBOX_WARN_ALLOCATED_CPU_MILLICORES']),
            int(values['ACS_SANDBOX_MAX_ALLOCATED_CPU_MILLICORES']),
        )
        self.assertLess(
            int(values['ACS_SANDBOX_WARN_ALLOCATED_MEMORY_MIB']),
            int(values['ACS_SANDBOX_MAX_ALLOCATED_MEMORY_MIB']),
        )


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


class AcsWorkflowRollbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = ACS_WORKFLOW.read_text(encoding='utf-8')
        cls.deploy_script = ACS_DEPLOY_SCRIPT.read_text(encoding='utf-8')

    def test_externalizes_remote_deploy_script_below_github_expression_limit(self):
        self.assertIn('< scripts/deploy-acs-orchestrator.sh', self.workflow)
        self.assertNotIn("<<'REMOTE'", self.workflow)
        syntax = subprocess.run(
            ['bash', '-n', str(ACS_DEPLOY_SCRIPT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as changed:
            changed.write('scripts/deploy-acs-orchestrator.sh\n')
            changed.flush()
            classified = subprocess.run(
                ['bash', str(ACS_CLASSIFIER), changed.name],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertIn('publish=true', classified.stdout)

    def test_lockfile_only_change_conservatively_triggers_publish(self):
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as changed:
            changed.write('pnpm-lock.yaml\n')
            changed.flush()
            classified = subprocess.run(
                ['bash', str(ACS_CLASSIFIER), changed.name],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertIn('publish=true', classified.stdout)
        self.assertIn('contract_check=false', classified.stdout)
        self.assertIn('reason=pnpm-lock.yaml runtime dependency resolution', classified.stdout)
        self.assertIn('skipped=none', classified.stdout)

    def test_direct_deploy_requires_enforced_lifecycle_policy_from_health(self):
        self.assertIn(
            "lifecycleEnabled: health.lifecycle?.enabled",
            self.deploy_script,
        )
        self.assertIn("lifecycleEnabled: true", self.deploy_script)
        self.assertIn("lifecyclePolicyMode: health.lifecyclePolicyMode", self.deploy_script)
        self.assertIn("lifecyclePolicyMode: 'enforce'", self.deploy_script)
        gate_start = self.deploy_script.index("const actual = { ...(health.runtimeConfig || {})")
        rollback = self.deploy_script.index("  rollback\n  exit 1\n", gate_start)
        self.assertGreater(rollback, gate_start)

    def test_test_fixtures_are_contract_only_and_never_publish(self):
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as changed:
            changed.write('acs-orchestrator/src/sandboxManagerTestFixtures.ts\n')
            changed.flush()
            classified = subprocess.run(
                ['bash', str(ACS_CLASSIFIER), changed.name],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertIn('publish=false', classified.stdout)
        self.assertIn('contract_check=true', classified.stdout)

    def test_all_main_pushes_reach_classifier_without_path_filter(self):
        push_start = self.workflow.index('  push:')
        dispatch_start = self.workflow.index('  workflow_dispatch:', push_start)
        push_trigger = self.workflow[push_start:dispatch_start]
        self.assertIn('branches: [main]', push_trigger)
        self.assertNotIn('paths:', push_trigger)

    def test_mixed_changes_run_publish_and_contract_gates(self):
        self.assertIn(
            "if: needs.changes.outputs.contract_check == 'true'",
            self.workflow,
        )
        self.assertNotIn(
            "if: needs.changes.outputs.publish != 'true' && "
            "needs.changes.outputs.contract_check == 'true'",
            self.workflow,
        )

    def test_browser_smoke_helper_is_sealed_and_triggers_publish(self):
        self.assertIn(
            'workspace-shared/.ky-agent/skills-pool/browser/scripts/acs_browser.py',
            self.workflow,
        )
        self.assertRegex(
            self.workflow,
            r'install -m 0555[\s\\]+workspace-shared/\.ky-agent/skills-pool/browser/scripts/acs_browser\.py',
        )
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as changed:
            changed.write('workspace-shared/.ky-agent/skills-pool/browser/scripts/acs_browser.py\n')
            changed.flush()
            classified = subprocess.run(
                ['bash', str(ACS_CLASSIFIER), changed.name],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertIn('publish=true', classified.stdout)

    def test_immutable_baseline_uploader_requires_an_exact_sha_acs_publish(self):
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as changed:
            changed.write('scripts/release/upload-oss-object-immutable.sh\n')
            changed.flush()
            classified = subprocess.run(
                ['bash', str(ACS_CLASSIFIER), changed.name],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(classified.returncode, 0, classified.stderr)
        self.assertIn('publish=true', classified.stdout)

    def test_verifies_per_pod_or_identical_shared_snat_before_process_replacement(self):
        prepare = self.deploy_script.index('if prepare_snat_rollback; then')
        replaced = self.deploy_script.index('PROCESS_REPLACED=true')
        self.assertLess(prepare, replaced)
        before_replacement = self.deploy_script[:replaced]
        self.assertIn('check-acs-shared-rollback-compatibility.mjs', before_replacement)
        self.assertIn('SNAT_ROLLBACK_SHARED_CONFIG_SAFE=true', before_replacement)
        self.assertIn('/snat/restore-per-pod', before_replacement)
        self.assertIn('rm -f "$SNAT_OPERATION_STATE_FILE"', self.deploy_script[prepare:replaced])

    def test_writes_acs_identity_before_drain_and_rolls_back_runtime_identity(self):
        identity_write = self.deploy_script.index('write-compatibility-acs-identity.mjs')
        drain = self.deploy_script.index('draining orchestrator pid=')
        self.assertLess(identity_write, drain)
        self.assertIn('RUNTIME_IDENTITY_UPDATED=true', self.deploy_script)
        rollback = self.deploy_script.split('\nrollback() {\n', 1)[1].split('\n}', 1)[0]
        self.assertIn('cp "$RUNTIME_IDENTITY_BAK" "$RUNTIME_IDENTITY_FILE"', rollback)

    def test_code_rollback_does_not_depend_on_candidate_health(self):
        rollback = self.deploy_script.split('\nrollback() {\n', 1)[1].split('\n}', 1)[0]
        self.assertNotIn('prepare_snat_rollback', rollback)
        self.assertIn('SNAT_ROLLBACK_PREPARED', rollback)
        self.assertIn('SNAT_ROLLBACK_OFFLINE_RESTORE', rollback)
        self.assertIn('SNAT_ROLLBACK_SHARED_CONFIG_SAFE', rollback)
        self.assertIn('restorePerPodCli.js', rollback)

    def test_deploy_smoke_can_run_without_opening_execution_maintenance(self):
        marker = 'X-ACS-Maintenance-Bypass: deploy-smoke-v1'
        self.assertGreaterEqual(self.deploy_script.count(marker), 2)
        self.assertIn(
            "'x-acs-maintenance-bypass': 'deploy-smoke-v1'",
            ACS_BROWSER_E2E.read_text(encoding='utf-8'),
        )

    def test_deploy_smoke_provision_and_execute_are_explicitly_classified(self):
        workload = r'\"workload\":{\"class\":\"deploy-smoke\"}'
        smoke_section = self.deploy_script.split(
            '# ── 5. Smoke: provision + execute 真实拉新镜像跑通 ──', 1,
        )[1]
        provision, execute = smoke_section.split('if [ "$SMOKE_OK" = "true" ]; then', 1)
        self.assertIn(workload, provision, 'provision smoke 缺少 workload 分类')
        self.assertIn(workload, execute, 'execute smoke 缺少 workload 分类')
        self.assertEqual(smoke_section.count(workload), 2)


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

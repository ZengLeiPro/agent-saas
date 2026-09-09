"""Temporary branch-only preparation helper; not included in the final PR tree."""
import hashlib
import json
import pathlib
import subprocess
import sys

BASE = '30cacdc2e05a993f9a47a79c6dc035deffeb9171'
ROOT = pathlib.Path.cwd()
PATHS = [
    '.github/workflows/ci.yml', '.github/workflows/acs-sandbox.yml',
    '.github/workflows/deploy-staging.yml', '.github/scripts/acs-classify.sh',
    'scripts/ci-acs-plan.mjs', 'scripts/release/unified-ci-evidence.mjs',
    'scripts/release/unified-ci-evidence.test.mjs',
    'scripts/release/unified-ci-workflow.test.mjs',
    'scripts/release/unified-ci-classification.test.mjs',
    'server/src/__tests__/acsDeployWorkflowContract.test.ts',
    'scripts/release/staging-release-evidence-workflow.test.mjs',
    'scripts/pr-preflight-contract.test.mjs', 'scripts/test_acs_operational_scripts.py',
    'scripts/release/classify-components.mjs', 'docs/unified-ci.md',
]


def replace_once(text, old, new):
    assert text.count(old) == 1, f'Expected one anchor: {old[:100]!r}'
    return text.replace(old, new, 1)


def patch():
    path = ROOT / 'scripts/release/classify-components.mjs'
    path.write_text(replace_once(path.read_text(), "  'scripts/ci-plan.mjs',", "  'scripts/ci-plan.mjs',\n  'scripts/ci-acs-plan.mjs',"))

    path = ROOT / 'scripts/pr-preflight-contract.test.mjs'
    text = path.read_text()
    text = replace_once(text, "['ci_plan', 'preflight_checks',", "['ci_plan', 'acs-impact-gate', 'preflight_checks',")
    text = replace_once(text, "assert.equal(build.if, '${{ !cancelled() }}');", "assert.equal(build.if, '${{ always() }}');")
    text = replace_once(text, r'/build:\s+[\s\S]*?if: \$\{\{ !cancelled\(\) \}\}/u', r'/build:\s+[\s\S]*?if: \$\{\{ always\(\) \}\}/u')
    path.write_text(text)

    path = ROOT / 'scripts/test_acs_operational_scripts.py'
    text = path.read_text()
    start = text.index('    def test_all_main_pushes_reach_classifier_without_path_filter(self):')
    end = text.index('    def test_browser_smoke_helper_is_sealed_and_triggers_publish(self):', start)
    text = text[:start] + '''    def test_all_main_pushes_reach_unified_ci_without_path_filter(self):
        ci = (REPO_ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8')
        push_start = ci.index('  push:')
        dispatch_start = ci.index('  workflow_dispatch:', push_start)
        push_trigger = ci[push_start:dispatch_start]
        self.assertIn('branches: [main]', push_trigger)
        self.assertNotIn('paths:', push_trigger)
        manual_trigger = self.workflow[:self.workflow.index('jobs:')]
        self.assertNotIn('  push:', manual_trigger)
        self.assertNotIn('  pull_request:', manual_trigger)

    def test_mixed_changes_run_one_union_acs_gate(self):
        ci = (REPO_ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8')
        self.assertEqual(ci.count('    name: ACS Impact Gate'), 1)
        self.assertIn("if: needs.ci_plan.outputs.acs_required == 'true'", ci)
        self.assertNotIn('  contract-check:', self.workflow)
        command = (
            "import { planAcsCi } from './scripts/ci-acs-plan.mjs'; "
            "const plan = planAcsCi('pull_request', "
            "['acs-orchestrator/src/config.ts', 'server/src/dws/authFlow.ts']); "
            "if (plan.required !== true) process.exit(1);"
        )
        checked = subprocess.run(
            ['node', '--input-type=module', '-e', command],
            cwd=REPO_ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(checked.returncode, 0, checked.stderr)

''' + text[end:]
    path.write_text(text)

    # Only the lightweight aggregate is always-run. Expensive ACS checks must stop with an obsolete PR.
    path = ROOT / '.github/workflows/ci.yml'
    text = path.read_text()
    start, end = text.index('  acs-impact-gate:'), text.index('  preflight_checks:')
    section = replace_once(text[start:end], '    if: ${{ always() }}', '    if: ${{ !cancelled() }}')
    path.write_text(text[:start] + section + text[end:])
    path = ROOT / 'server/src/__tests__/acsDeployWorkflowContract.test.ts'
    path.write_text(replace_once(path.read_text(), "expect(gate).toContain('if: ${{ always() }}');", "expect(gate).toContain('if: ${{ !cancelled() }}');"))
    path = ROOT / 'scripts/release/unified-ci-workflow.test.mjs'
    path.write_text(replace_once(path.read_text(), r'assert.match(acs, /if: \$\{\{ always\(\) \}\}/u);', r'assert.match(acs, /if: \$\{\{ !cancelled\(\) \}\}/u);'))

    (ROOT / 'scripts/release/unified-ci-classification.test.mjs').write_text('''import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPath } from './classify-components.mjs';

for (const path of [
  'scripts/ci-acs-plan.mjs',
  'scripts/release/unified-ci-evidence.mjs',
  'scripts/release/unified-ci-workflow.test.mjs',
]) {
  test(`unified CI helper is an explicitly mapped non-runtime input: ${path}`, () => {
    assert.deepEqual(classifyPath(path), { components: [], blockingReason: null });
  });
}
''')
    print('Legacy migration assertions, release classification and PR cancellation updated.')


def export_blobs():
    entries = []
    for path in PATHS:
        content = (ROOT / path).read_bytes()
        expected = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
        response = json.loads(subprocess.check_output(
            ['gh', 'api', '--method', 'POST', 'repos/ZengLeiPro/agent-saas/git/blobs', '--input', '-'],
            input=json.dumps({'content': content.decode('utf-8'), 'encoding': 'utf-8'}), text=True))
        assert response['sha'] == expected
        old_entry = subprocess.check_output(['git', 'ls-tree', BASE, '--', path], text=True)
        mode = old_entry.split()[0] if old_entry.strip() else '100644'
        entries.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': expected})
    print('FINAL_BLOBS_JSON=' + json.dumps(entries))
    print('Only reviewed blobs uploaded; no branch, tree, ruleset or deployment updated.')


if __name__ == '__main__':
    if sys.argv[1:] == ['export-blobs']:
        export_blobs()
    else:
        patch()

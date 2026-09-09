"""One-shot branch-only editing helper. Excluded from the proposed final tree."""
import json
import pathlib
import re
import subprocess
import sys

BASE = '30cacdc2e05a993f9a47a79c6dc035deffeb9171'
ROOT = pathlib.Path.cwd()


def replace_once(text, old, new):
    assert text.count(old) == 1, f'Expected one anchor: {old[:100]!r}'
    return text.replace(old, new, 1)


def section(text, start, end):
    begin = text.index(start)
    finish = text.index(end, begin + len(start))
    return text[begin:finish]


def prepare():
    ci_path = ROOT / '.github/workflows/ci.yml'
    acs_path = ROOT / '.github/workflows/acs-sandbox.yml'
    ci = ci_path.read_text()
    acs = acs_path.read_text()
    assert subprocess.check_output(['git', 'hash-object', str(ci_path)], text=True).strip() == 'e61fafaff5d04f4f3cc905acbdad46c998e12f4d'
    assert subprocess.check_output(['git', 'hash-object', str(acs_path)], text=True).strip() == '1137e1e341b1acd3c6a159b05661d712087fa746'
    old_impact = section(acs, '  acs-impact-gate:\n', '  changes:\n')
    retained_steps = old_impact[old_impact.index('      - name: 配置 pnpm'):]
    retained_steps = retained_steps.replace("steps.impact.outputs.required == 'true'", "needs.ci_plan.outputs.acs_required == 'true'")
    new_impact = '''  # Stable required check; an intentional PR no-op succeeds, but a failed plan never does.
  acs-impact-gate:
    name: ACS Impact Gate
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    needs: ci_plan
    if: ${{ always() }}
    permissions:
      contents: read
    steps:
      - name: 校验 ACS 执行计划
        env:
          CI_PLAN_RESULT: ${{ needs.ci_plan.result }}
          ACS_REQUIRED: ${{ needs.ci_plan.outputs.acs_required }}
        run: |
          set -euo pipefail
          case "$CI_PLAN_RESULT:$ACS_REQUIRED" in
            success:true|success:false) ;;
            *) echo '::error::ACS CI plan is missing or unsuccessful'; exit 1 ;;
          esac
          if [ "$ACS_REQUIRED" = false ]; then
            echo 'ACS Impact Gate: not_required (verified PR plan)' >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: 检出代码
        if: needs.ci_plan.outputs.acs_required == 'true'
        uses: actions/checkout@v5
        with:
          fetch-depth: 0

''' + retained_steps
    plan_step = '''      - name: 规划 ACS 专项检查
        id: acs
        run: >-
          node scripts/ci-acs-plan.mjs
          --event "${{ github.event_name }}"
          --base "${{ github.event.pull_request.base.sha }}"
          --head "${{ github.event.pull_request.head.sha }}"
          --output "$GITHUB_OUTPUT"
          --summary "$GITHUB_STEP_SUMMARY"

'''
    ci = replace_once(ci, 'name: APP CI\n', 'name: CI\n')
    ci = replace_once(ci, '# APP CI: parallel checks/tests/artifact validation; manual compatibility publishing is Web-only', '# Unified CI: parallel App + ACS checks; legacy manual compatibility publishing remains Web-only')
    ci = replace_once(ci, '      mode: ${{ steps.plan.outputs.mode }}', '      acs_required: ${{ steps.acs.outputs.required }}\n      mode: ${{ steps.plan.outputs.mode }}')
    ci = replace_once(ci, '  preflight_checks:\n', plan_step + new_impact + '  preflight_checks:\n')
    build = section(ci, '  build:\n', '  deploy_plan:\n')
    new_build = replace_once(build, '        ci_plan,\n', '        ci_plan,\n        acs-impact-gate,\n')
    new_build = replace_once(new_build, '    if: ${{ !cancelled() }}', '    if: ${{ always() }}')
    new_build = replace_once(new_build, '          CI_PLAN_RESULT:', '          ACS_IMPACT_GATE_RESULT: ${{ needs.acs-impact-gate.result }}\n          CI_PLAN_RESULT:')
    new_build = replace_once(new_build, '            "ci_plan=$CI_PLAN_RESULT=true" \\\n', '            "ci_plan=$CI_PLAN_RESULT=true" \\\n            "acs_impact_gate=$ACS_IMPACT_GATE_RESULT=true" \\\n')
    ci = replace_once(ci, build, new_build)
    ci = ci.replace('# 保留仓库 Ruleset 使用的唯一 required check 名称。', '# 保留仓库 Ruleset 使用的 required check 名称；Build & Check 汇总 App 与 ACS。')
    ci_path.write_text(ci)

    acs = replace_once(acs, 'name: ACS CI\n', 'name: ACS Manual Deploy\n')
    trigger_prefix = section(acs, 'on:\n', '  workflow_dispatch:\n')
    acs = replace_once(acs, trigger_prefix, '# Automatic PR/main checks now live in ci.yml. This compatibility entry is manual only.\non:\n')
    acs = replace_once(acs, old_impact, '')
    contract = section(acs, '  contract-check:\n', '  # ── 方案 C')
    acs = replace_once(acs, contract, '')
    acs = acs.replace('# PR 检查淘汰旧 head；main 检查各自完成。生产 mutation 仍使用 job 级不可取消锁。', '# 人工兼容发布保留原有并发语义；生产 mutation 使用 job 级不可取消锁。')
    acs = acs.replace('#   gate: typecheck + test（push/dispatch 都跑, 代码门禁）', '#   gate: typecheck + test（仅 dispatch，代码门禁）')
    acs_path.write_text(acs)

    path = ROOT / '.github/workflows/deploy-staging.yml'
    staging = path.read_text()
    old_evidence = section(staging, '      - name: 解析同一发布 SHA 的 ACS 证据\n', '      - name: 存在时复用不可变发布证据\n')
    new_evidence = '''      - name: 解析同一发布 SHA 的 ACS 证据
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          # ci.yml now owns both gates. Never wait for the manual ACS deployment workflow.
          # Read every latest-job page; successful jobs from earlier rerun attempts remain valid.
          gh api --paginate --slurp \\
            "repos/$GITHUB_REPOSITORY/actions/runs/$APP_CI_RUN_ID/jobs?filter=latest&per_page=100" \\
            > "$RUNNER_TEMP/unified-ci-jobs-pages.json"
          # Reject a rerun that raced the trusted CI read and job collection.
          gh api "repos/$GITHUB_REPOSITORY/actions/runs/$APP_CI_RUN_ID" \\
            > "$RUNNER_TEMP/unified-ci-run.json"
          node scripts/release/unified-ci-evidence.mjs \\
            "$RUNNER_TEMP/app-ci-workflow.json" "$RUNNER_TEMP/app-ci-run.json" \\
            "$RUNNER_TEMP/unified-ci-jobs-pages.json" "$RUNNER_TEMP/unified-ci-run.json" \\
            "$RELEASE_SHA" "$GITHUB_REPOSITORY" > "$RUNNER_TEMP/checks.json"

'''
    path.write_text(replace_once(staging, old_evidence, new_evidence))

    path = ROOT / '.github/scripts/acs-classify.sh'
    classifier = path.read_text()
    classifier = replace_once(classifier, '    .github/workflows/deploy-staging.yml|.github/workflows/promote-release.yml|', '    scripts/ci-acs-plan.mjs|scripts/release/unified-ci*.mjs|.github/workflows/deploy-staging.yml|.github/workflows/promote-release.yml|')
    path.write_text(classifier)

    path = ROOT / 'server/src/__tests__/acsDeployWorkflowContract.test.ts'
    tests = path.read_text()
    start = "  it('为所有 main PR 提供固定名称且不读取生产 secret 的 ACS Impact Gate'"
    end = "  it('对普通 UI、ACS 源码、managed unit 和 Workflow 给出稳定分类'"
    tests = replace_once(tests, section(tests, start, end), '''  it('统一 CI 为 main PR 提供固定名称且不读取生产 secret 的 ACS Impact Gate', () => {
    expect(ciWorkflow).toContain('pull_request:\\n    branches: [main]');
    expect(ciWorkflow).toContain('name: ACS Impact Gate');
    const gateStart = ciWorkflow.indexOf('  acs-impact-gate:');
    const gate = ciWorkflow.slice(gateStart, ciWorkflow.indexOf('  preflight_checks:', gateStart));
    expect(gate).toContain('needs: ci_plan');
    expect(gate).toContain('if: ${{ always() }}');
    expect(gate).toContain('not_required');
    expect(gate).not.toContain('secrets.');
    expect(gate).not.toContain('workflow_dispatch');
    expect(workflow).not.toContain('  acs-impact-gate:');
  });

''')
    start = "  it('让所有 main push 进入 changes job，并由 classifier 独占路径分类'"
    end = '  it.each(classificationCases)'
    tests = replace_once(tests, section(tests, start, end), '''  it('统一 CI 接收全部 main push，ACS 发布入口仅保留手动触发', () => {
    const triggers = ciWorkflow.slice(ciWorkflow.indexOf('on:'), ciWorkflow.indexOf('concurrency:'));
    expect(triggers).toContain('push:\\n    branches: [main]');
    expect(triggers).not.toContain('paths:');
    const manualTriggers = workflow.slice(0, workflow.indexOf('jobs:'));
    expect(manualTriggers).toContain('workflow_dispatch:');
    expect(manualTriggers).not.toContain('  push:');
    expect(manualTriggers).not.toContain('  pull_request:');
  });

''')
    suite = section(tests, "  it('在 required、contract 与 publish gate 中执行完整", "  it('由 PostgreSQL")
    new_suite = suite.replace('在 required、contract 与 publish gate 中执行完整', '在统一 CI 与人工部署中保留完整')
    new_suite = new_suite.replace('workflow.match', '(ciWorkflow + workflow).match').replace('workflow.split', '(ciWorkflow + workflow).split')
    new_suite = new_suite.replace('toHaveLength(3)', 'toHaveLength(2)').replace('toHaveLength(4)', 'toHaveLength(3)')
    tests = replace_once(tests, suite, new_suite)
    path.write_text(tests)

    path = ROOT / 'scripts/release/staging-release-evidence-workflow.test.mjs'
    tests = path.read_text()
    start = '  assert.match(workflow, /acs-classify\\.sh/u);'
    end = '  assert.match(workflow, /只读获取在线生产状态/u);'
    old = section(tests, start, end)
    new = '''  const acsEvidenceStart = workflow.indexOf('- name: 解析同一发布 SHA 的 ACS 证据');
  const acsEvidenceEnd = workflow.indexOf('- name: 存在时复用不可变发布证据');
  assert.ok(acsEvidenceStart > 0 && acsEvidenceEnd > acsEvidenceStart);
  const acsEvidence = workflow.slice(acsEvidenceStart, acsEvidenceEnd);
  assert.doesNotMatch(acsEvidence, /actions\\/workflows\\/acs-sandbox\\.yml\\/runs/u);
  assert.match(acsEvidence, /actions\\/runs\\/\\$APP_CI_RUN_ID\\/jobs\\?filter=latest&per_page=100/u);
  assert.match(acsEvidence, /gh api --paginate --slurp/u);
  assert.doesNotMatch(acsEvidence, /jobs\\?filter=all/u);
  assert.match(acsEvidence, /unified-ci-evidence\\.mjs/u);
  const evidenceHelper = await readFile(new URL('./unified-ci-evidence.mjs', import.meta.url), 'utf8');
  assert.ok(evidenceHelper.includes('Build & Check'));
  assert.ok(evidenceHelper.includes('ACS Impact Gate'));
  assert.match(evidenceHelper, /matches.length === 1/u);
  assert.match(evidenceHelper, /job.conclusion === 'success'/u);
  assert.doesNotMatch(acsWorkflow.slice(0, acsWorkflow.indexOf('jobs:')), /\\n  (push|pull_request):/u);
'''
    path.write_text(replace_once(tests, old, new))

    # Guard against accidental changes to production deployment bodies and irreversible identity contracts.
    old_ci = subprocess.check_output(['git', 'show', f'{BASE}:.github/workflows/ci.yml'], text=True)
    old_acs = subprocess.check_output(['git', 'show', f'{BASE}:.github/workflows/acs-sandbox.yml'], text=True)
    assert ci[ci.index('  deploy_plan:\n'):] == old_ci[old_ci.index('  deploy_plan:\n'):]
    assert acs[acs.index('  build-deploy:\n'):] == old_acs[old_acs.index('  build-deploy:\n'):]
    print('Prepared unified CI; production job bodies preserved byte-for-byte.')


def publish_tree():
    allowed = [
        '.github/workflows/ci.yml', '.github/workflows/acs-sandbox.yml', '.github/workflows/deploy-staging.yml',
        '.github/scripts/acs-classify.sh', 'scripts/ci-acs-plan.mjs',
        'scripts/release/unified-ci-evidence.mjs', 'scripts/release/unified-ci-evidence.test.mjs',
        'scripts/release/unified-ci-workflow.test.mjs',
        'server/src/__tests__/acsDeployWorkflowContract.test.ts',
        'scripts/release/staging-release-evidence-workflow.test.mjs', 'docs/unified-ci.md',
    ]
    entries = []
    for path in allowed:
        old_entry = subprocess.check_output(['git', 'ls-tree', BASE, '--', path], text=True)
        mode = old_entry.split()[0] if old_entry.strip() else '100644'
        entries.append({'path': path, 'mode': mode, 'type': 'blob', 'content': (ROOT / path).read_text()})
    base_tree = subprocess.check_output(['git', 'rev-parse', f'{BASE}^{{tree}}'], text=True).strip()
    payload = {'base_tree': base_tree, 'tree': entries}
    result = json.loads(subprocess.check_output(
        ['gh', 'api', '--method', 'POST', 'repos/ZengLeiPro/agent-saas/git/trees', '--input', '-'],
        input=json.dumps(payload), text=True))
    print(f"PREPARED_TREE_SHA={result['sha']}")
    print('Final tree includes only the 11 reviewed paths; no preparation workflow/helper.')


if __name__ == '__main__':
    if sys.argv[1:] == ['publish-tree']:
        publish_tree()
    else:
        prepare()

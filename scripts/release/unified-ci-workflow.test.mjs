import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseClassification, planAcsCi } from '../ci-acs-plan.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const ci = read('.github/workflows/ci.yml');
const promotion = read('.github/workflows/promote-release.yml');
const staging = read('.github/workflows/deploy-staging.yml');
const job = (text, id) => {
  const start = text.indexOf(`  ${id}:\n`);
  assert(start > 0, `Missing job ${id}`);
  const tail = text.slice(start + 1);
  const next = tail.search(/\n  [a-zA-Z_][\w-]*:\n/u);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};

test('a single automatic CI preserves both required check names and consumes one ACS plan', () => {
  assert.match(ci, /^name: CI$/mu);
  const triggers = ci.slice(ci.indexOf('\non:\n'), ci.indexOf('\nconcurrency:'));
  assert.match(triggers, /push:\s+branches: \[main\]/u);
  assert.match(triggers, /pull_request:\s+branches: \[main\]/u);
  assert.doesNotMatch(triggers, /paths(?:-ignore)?:/u);
  assert.equal(
    existsSync(new URL('../../.github/workflows/acs-sandbox.yml', import.meta.url)),
    false,
  );
  assert.doesNotMatch(
    promotion.slice(0, promotion.indexOf('\njobs:')),
    /\n  (push|pull_request):/u,
  );
  const acs = job(ci, 'acs-impact-gate');
  assert.match(acs, /name: ACS Impact Gate/u);
  assert.match(acs, /needs: ci_plan/u);
  assert.match(acs, /if: \$\{\{ !cancelled\(\) \}\}/u);
  assert.match(acs, /CI_PLAN_RESULT: \$\{\{ needs.ci_plan.result \}\}/u);
  assert.match(acs, /ACS_REQUIRED: \$\{\{ needs.ci_plan.outputs.acs_required \}\}/u);
  assert.match(acs, /success:true\|success:false/u);
  assert.match(acs, /exit 1/u);
  assert.doesNotMatch(acs, /secrets\.|environment:\s*production|continue-on-error/u);
  assert.match(job(ci, 'ci_plan'), /node scripts\/ci-acs-plan.mjs/u);
  assert.match(ci, /acs_required: \$\{\{ steps.acs.outputs.required \}\}/u);
  const aggregate = job(ci, 'build');
  assert.match(aggregate, /name: Build & Check/u);
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(aggregate, /\n        acs-impact-gate,/u);
  assert.match(aggregate, /ACS_IMPACT_GATE_RESULT: \$\{\{ needs.acs-impact-gate.result \}\}/u);
  assert.match(aggregate, /acs_impact_gate=\$ACS_IMPACT_GATE_RESULT=true/u);
});

test('manual production boundaries and stable artifact identity are preserved', () => {
  assert.match(ci, /web_only_compatibility:/u);
  assert.match(ci, /github.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(promotion, /workflow_dispatch:/u);
  const deploy = job(promotion, 'promote');
  assert.match(deploy, /environment: production/u);
  assert.match(promotion, /group: production-runtime\s+cancel-in-progress: false/u);
  assert.match(
    deploy,
    /if: github.ref == 'refs\/heads\/main' && \(needs.dispatch.outputs.operation == 'promote' \|\| needs.dispatch.outputs.operation == 'checkpoint-repair'\)/u,
  );
  assert.match(
    ci,
    /name: release-packages-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/u,
  );
  assert.match(read('scripts/release/prepared-release.mjs'), /\.github\/workflows\/ci.yml@/u);
});

test('Staging consumes a paginated job list and rereads the same unified run before writing evidence', () => {
  const section = staging.slice(
    staging.indexOf('- name: 解析同一发布 SHA 的 ACS 证据'),
    staging.indexOf('- name: 存在时复用不可变发布证据'),
  );
  assert.doesNotMatch(section, /acs-sandbox.yml\/runs|not_required/u);
  assert.match(section, /gh api --paginate --slurp/u);
  assert.match(section, /actions\/runs\/\$APP_CI_RUN_ID\/jobs\?filter=latest&per_page=100/u);
  assert.match(section, /actions\/runs\/\$APP_CI_RUN_ID"/u);
  assert.match(section, /node scripts\/release\/unified-ci-evidence.mjs/u);
  assert(section.indexOf('/jobs?filter=latest') < section.indexOf('/actions/runs/$APP_CI_RUN_ID"'));
  assert(
    section.indexOf('/actions/runs/$APP_CI_RUN_ID"') <
      section.indexOf('node scripts/release/unified-ci-evidence.mjs'),
  );
});

test('aggregate executes and rejects failed, cancelled or unexpectedly skipped ACS', () => {
  const aggregate = job(ci, 'build');
  const run = aggregate
    .slice(aggregate.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  assert.match(run, /exit "\$failed"/u);
  const env = { ...process.env };
  for (const name of [
    'CI_PLAN',
    'PREFLIGHT_CHECKS',
    'MIGRATION_REVIEWS',
    'TESTS',
    'POSTGRES_CONTRACTS',
    'WEB_PRODUCTION',
    'MOBILE_ROUTER_EXPORT',
    'MOBILE_CONTRACT',
    'RELEASE_PACKAGES',
    'WRITER_BUNDLE',
    'BROWSER_SMOKE',
    'ACS_IMPACT_GATE',
  ])
    env[`${name}_RESULT`] = 'success';
  for (const name of ['POSTGRES', 'WEB_PRODUCTION', 'MOBILE', 'RELEASE_PACKAGES', 'BROWSER_SMOKE'])
    env[`PLAN_${name}`] = 'true';
  assert.equal(spawnSync('bash', ['-c', run], { env }).status, 0);
  for (const status of ['failure', 'cancelled', 'skipped', '']) {
    assert.equal(
      spawnSync('bash', ['-c', run], {
        env: { ...env, ACS_IMPACT_GATE_RESULT: status },
      }).status,
      1,
      status,
    );
  }
  assert.equal(
    spawnSync('bash', ['-c', run], {
      env: { ...env, PLAN_POSTGRES: 'false', POSTGRES_CONTRACTS_RESULT: 'skipped' },
    }).status,
    0,
  );
  assert.equal(
    spawnSync('bash', ['-c', run], {
      env: { ...env, CI_PLAN_RESULT: 'failure' },
    }).status,
    1,
  );
});

test('main and manual CI always verify ACS, including documentation-only changes', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(planAcsCi(event, ['README.md']).required, true);
  }
  assert.throws(() => planAcsCi('pull_request'), /unavailable/u);
  assert.throws(() => planAcsCi('pull_request_target'), /Unsupported/u);
});

for (const [file, required] of [
  ['README.md', false],
  ['web/src/App.tsx', false],
  ['acs-orchestrator/src/config.ts', true],
  ['pnpm-lock.yaml', true],
  ['server/src/dws/authFlow.ts', true],
  ['server/src/runtime/sandboxLifecycleService.ts', true],
  ['.github/workflows/ci.yml', true],
  ['scripts/ci-acs-plan.mjs', true],
  ['scripts/release/unified-ci-evidence.mjs', true],
]) {
  test(`PR ACS classification: ${file} => ${required}`, () => {
    assert.equal(planAcsCi('pull_request', [file]).required, required);
  });
}

test('publish and contract changes select only one ACS gate; malformed output never skips it', () => {
  for (const [publish, contract, required] of [
    ['false', 'false', false],
    ['true', 'false', true],
    ['false', 'true', true],
    ['true', 'true', true],
  ]) {
    assert.equal(
      parseClassification(`publish=${publish}\ncontract_check=${contract}\nreason=test`).required,
      required,
    );
  }
  for (const output of [
    '',
    'publish=false',
    'publish=false\ncontract_check=maybe',
    'publish=garbage\ncontract_check=true',
    'publish=false\npublish=true\ncontract_check=false',
  ]) {
    assert.throws(() => parseClassification(output));
  }
});

test('real Worker source entry builds workspace exports before allocating fixtures', () => {
  const source = readFileSync('server/scripts/verify-runtime-multiprocess-e2e.mts', 'utf8');
  const build = source.indexOf(
    "await execFile('pnpm', ['--filter', 'server^...', '--if-present', 'run', 'build']",
  );
  const allocate = source.indexOf('const rootDir = await mkdtemp');
  assert(
    build >= 0 && allocate > build,
    'source entry must build workspace exports before startup',
  );
  assert.match(
    source.slice(source.lastIndexOf('if (', build), build),
    /!options\.bundleDirectory/u,
  );
  assert.doesNotMatch(job(ci, 'postgres_contracts'), /continue-on-error/u);
});

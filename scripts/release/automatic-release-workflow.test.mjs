import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const production = await readFile(
  new URL('../../.github/workflows/promote-release.yml', import.meta.url),
  'utf8',
);
const staging = await readFile(
  new URL('../../.github/workflows/deploy-staging.yml', import.meta.url),
  'utf8',
);
function job(text, name) {
  const start = text.indexOf(`  ${name}:\n`);
  assert(start >= 0);
  const tail = text.slice(start + 3);
  const next = tail.search(/\n  [a-z_][a-z_-]*:\n/u);
  return next < 0 ? text.slice(start) : text.slice(start, start + 3 + next);
}
function step(text, name) {
  const start = text.indexOf(`      - name: ${name}\n`);
  assert(start >= 0, name);
  const end = text.indexOf('\n      - ', start + 10);
  return text.slice(start, end < 0 ? undefined : end);
}
function script(block) {
  return block
    .slice(block.indexOf('        run: |\n') + 15)
    .split('\n')
    .map((s) => (s.startsWith('          ') ? s.slice(10) : s))
    .join('\n');
}

test('coordinator has its own queue and no production secrets; every mutation keeps production-runtime', () => {
  assert(!production.slice(0, production.indexOf('\njobs:')).includes('\nconcurrency:'));
  const auto = job(production, 'automatic');
  assert.match(auto, /group: production-auto-requests\s+cancel-in-progress: false\s+queue: max/u);
  assert.doesNotMatch(auto, /secrets\.|environment: production|ECS_SSH_KEY/u);
  assert.match(auto, /actions: write/u);
  assert.match(auto, /deployments: write/u);
  for (const name of ['promote', 'web_recovery']) {
    const value = job(production, name);
    assert.match(value, /group: production-runtime\s+cancel-in-progress: false\s+queue: max/u);
    assert.match(value, /environment: production/u);
    assert.doesNotMatch(value, /needs.dispatch.outputs.operation == 'auto'/u);
  }
});
test('automatic is the UI default without removing any manual advanced operation', () => {
  assert.match(production, /default: auto/u);
  for (const op of ['promote', 'checkpoint-repair', 'web-recovery-audit', 'web-recovery-repair'])
    assert(production.includes(op));
  assert.match(job(production, 'dispatch'), /automatic-release-child\.mjs/u);
  assert.match(staging, /needs: \[ensure-evidence-writer, guard\]/u);
  assert.match(job(staging, 'guard'), /source_sha: \$\{\{ steps.binding.outputs.source_sha \}\}/u);
});
test('automatic child authorization is retained as a durable diagnostic in every mutating workflow', () => {
  for (const workflow of [production, staging]) {
    assert.match(workflow, /AUTOMATIC_CHILD_EVIDENCE_PATH: \$\{\{ runner\.temp \}\}\/automatic-child-authorization\.jsonl/u);
    assert.match(workflow, /automatic-child-authorization\.jsonl/u);
  }
});
test('manual child guard really binds source to github.sha, rejects non-main and mixed delegation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manual-source-'));
  try {
    const event = join(dir, 'event.json'),
      output = join(dir, 'output');
    await writeFile(event, JSON.stringify({ inputs: { reason: 'manual' } }));
    const env = {
      ...process.env,
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'c'.repeat(40),
    };
    const cli = new URL('./automatic-release-child.mjs', import.meta.url).pathname;
    let result = spawnSync(process.execPath, [cli, 'deploy-staging.yml'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      await readFile(output, 'utf8'),
      new RegExp(`source_sha=${env.GITHUB_SHA}\\nautomatic=false`),
    );
    result = spawnSync(process.execPath, [cli, 'deploy-staging.yml'], {
      env: { ...env, GITHUB_REF: 'refs/heads/other' },
    });
    assert.equal(result.status, 1);
    await writeFile(event, JSON.stringify({ inputs: { automation_key: 'auto:1:refresh' } }));
    result = spawnSync(process.execPath, [cli, 'deploy-staging.yml'], { env });
    assert.equal(result.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('refreshed evidence is bound to exact same-run artifact, never overwrites immutable by-SHA Writer', () => {
  const prep = job(staging, 'prepare-evidence');
  assert.match(prep, /存在时复用不可变发布证据\n\s+if: env.AUTOMATIC_RELEASE != 'true'/u);
  assert.match(prep, /id: fresh_authority[\s\S]*actions\/upload-artifact@v7/u);
  assert.match(
    prep,
    /if \[ "\$AUTOMATIC_RELEASE" = true \]; then\s+cp "\$RUNNER_TEMP\/release-evidence.json"/u,
  );
  assert.match(prep, /else\s+node scripts\/release\/publish-release-evidence.mjs/u);
  for (const name of ['prepare-acs', 'build-deploy-verify']) {
    const j = job(staging, name);
    assert.match(
      j,
      /artifact-ids: \$\{\{ needs.prepare-evidence.outputs.evidence_artifact_id \}\}/u,
    );
    assert.match(j, /RELEASE_SOURCE_SHA: \$\{\{ needs.prepare-evidence.outputs.source_sha \}\}/u);
  }
  assert.match(staging, /staging-source-binding.json[\s\S]*authoritative-evidence.json/u);
});
test('all refreshed build, tag and deployment identities use pinned source, while scripts use current engine', () => {
  const build = job(staging, 'build-deploy-verify');
  assert.match(build, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(build, /git merge-base --is-ancestor "\$RELEASE_SOURCE_SHA" origin\/main/u);
  assert.match(build, /git tag -a "\$STAGING_RELEASE_ID" "\$RELEASE_SOURCE_SHA"/u);
  assert.match(build, /--sha="\$RELEASE_SOURCE_SHA"/u);
  assert.match(build, /--arg ref "\$RELEASE_SOURCE_SHA"/u);
  assert.match(build, /automaticSource:\$sourceBinding/u);
  assert.match(build, /staging-source-authority.mjs create/u);
  assert.doesNotMatch(
    build,
    /--sha="\$GITHUB_SHA"|sha=\$GITHUB_SHA|git tag -a[^\n]*"\$GITHUB_SHA"/u,
  );
});
test('the actual live-observation Bash cannot fall back to checkpoint in automatic mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-baseline-'));
  try {
    const body = script(step(staging, '只读获取在线生产状态'));
    const probe = `ssh() { case "$*" in *read-production-state.mjs*) return 1;; *production-checkpoint.mjs*) echo BAD_FALLBACK >> "$TRACE";; *) return 0;; esac; }; scp() { :; }; export -f ssh scp\n`;
    const path = join(dir, 'probe.sh');
    await writeFile(path, probe + body);
    const env = {
      ...process.env,
      RUNNER_TEMP: dir,
      GITHUB_RUN_ID: '10',
      GITHUB_RUN_ATTEMPT: '1',
      ECS_USER: 'test',
      ECS_HOST: 'localhost',
      PRODUCTION_CONFIG_IDENTITY_STAGE: 'steady-state',
      AUTOMATIC_RELEASE: 'true',
      TRACE: join(dir, 'trace'),
    };
    const result = spawnSync('bash', [path], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checkpoint fallback is not allowed/u);
    await assert.rejects(readFile(env.TRACE), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('every modified workflow Bash block is syntactically valid after Actions expression substitution', () => {
  let count = 0;
  for (const text of [production, staging]) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s+run: \|$/u.test(lines[i])) continue;
      const indent = lines[i].match(/^ */u)[0].length;
      const body = [];
      while (++i < lines.length && (!lines[i].trim() || lines[i].match(/^ */u)[0].length > indent))
        body.push(lines[i].slice(indent + 2));
      i--;
      const result = spawnSync('bash', ['-n'], {
        input: body.join('\n').replace(/\$\{\{.*?\}\}/gu, 'test'),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr + '\n' + body.slice(0, 3).join('\n'));
      count++;
    }
  }
  assert(count > 50);
});

test('queued preparation rechecks parent immediately before Writer and Staging runtime mutation', () => {
  for (const name of ['原子升级并验证 Writer', '部署精确的测试环境 API、Worker 与 ACS 产物']) {
    const guard = step(staging, `${name}前重新核对父请求`);
    assert.match(guard, /inputs\.automation_id != ''/u);
    assert.match(guard, /automatic-release-child\.mjs deploy-staging\.yml/u);
    assert(staging.indexOf(guard) < staging.indexOf(`      - name: ${name}\n`));
  }
});

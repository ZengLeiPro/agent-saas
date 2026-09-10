import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { reconcilePromotion } from './reconcile-promotion.mjs';

const workflow = await readFile(
  new URL('../../.github/workflows/promote-release.yml', import.meta.url),
  'utf8',
);
const deploy = await readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8');

test('target convergence cannot turn a failed handoff into completed, even with successful receipt uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-outcome-'));
  try {
    const part = { gitSha: 'a'.repeat(40), artifactDigest: `sha256:${'a'.repeat(64)}` };
    const target = {
      api: part,
      runtimeWorker: part,
      web: part,
      acs: {
        gitSha: part.gitSha,
        orchestratorArtifactDigest: part.artifactDigest,
        sandboxImageDigest: part.artifactDigest,
      },
    };
    const reconciliation = reconcilePromotion({
      releaseId: 'rc-20260908-01',
      before: target,
      target,
      observed: target,
      observationComplete: true,
      configIdentityConfirmed: true,
    });
    assert.equal(reconciliation.outcome, 'completed');
    await writeFile(join(root, 'reconcile.json'), JSON.stringify(reconciliation));
    await writeFile(join(root, 'deployment-engine.json'), JSON.stringify({ sourceSha: 'a'.repeat(40), implementationDigest: 'sha256:' + 'b'.repeat(64), contract: { schemaVersion: 1 } }));
    const step = workflow.slice(workflow.indexOf('      - name: 记录真实最终结果'));
    const shell = step
      .split('        run: |\n')[1]
      .split('          pnpm exec tsx')[0]
      .split('\n')
      .map((line) => line.replace(/^          /u, ''))
      .join('\n');
    for (const outcome of ['failure', 'cancelled', 'skipped', 'success']) {
      const script = shell
        .replace(/\$\{\{ steps\.(\w+)\.outcome \}\}/gu, (_, name) =>
          name === 'deploy_app' ? outcome : 'success',
        )
        .replace(/\$\{\{ steps\.readback\.outputs\.target_match \}\}/gu, 'true');
      const result = spawnSync('bash', ['-c', `${script}\nprintf '%s' "$outcome"`], {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: root, MIGRATION_PHASE: 'none' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, outcome === 'success' ? 'completed' : 'needs_human');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('handoff recovery repeats both retired-generation checks and writes proof only after both succeed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-recovery-'));
  try {
    await writeFile(join(root, 'api-color'), 'green');
    await writeFile(join(root, 'worker-color'), 'blue');
    const definition = deploy.slice(
      deploy.indexOf('complete_app_handoff() {'),
      deploy.indexOf('\ndeploy_app() {'),
    );
    for (const failRole of ['worker', 'api', 'none']) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
other_color() { [ "$1" = blue ] && echo green || echo blue; }
hand_off_retired_authority() {
  echo "$1" >&2
  case "$FAIL_ROLE:$1" in worker:agent-saas-runtime-worker*|api:agent-saas-server*) return 1 ;; esac
}
${definition}
complete_app_handoff`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FAIL_ROLE: failRole,
            ACTIVE_COLOR_PATH: join(root, 'api-color'),
            WORKER_ACTIVE_COLOR_PATH: join(root, 'worker-color'),
            MANIFEST_PATH: join(root, 'manifest.json'),
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '2',
            release_id: 'rc-20260908-01',
            manifest_digest: `sha256:${'a'.repeat(64)}`,
          },
        },
      );
      assert.equal(result.status === 0, failRole === 'none', result.stderr);
      if (failRole === 'none') {
        assert.match(
          result.stderr,
          /agent-saas-runtime-worker@green[\s\S]*agent-saas-server@blue/u,
        );
        const proof = JSON.parse(await readFile(join(root, 'app-handoff-123-2.json'), 'utf8'));
        assert.deepEqual(proof.active, { api: 'green', runtimeWorker: 'blue' });
        assert.equal(proof.status, 'acknowledged');
      } else {
        await assert.rejects(readFile(join(root, 'app-handoff-123-2.json')), { code: 'ENOENT' });
      }
    }
    assert.match(deploy, /if \[ "\$VERIFY_ONLY" = true \] && \[ "\$RESUME_HANDOFF" != true \]/u);
    assert.match(
      deploy,
      /if \[ "\$RESUME_HANDOFF" = true \]; then complete_app_handoff; else deploy_app; fi/u,
    );
    const appStep = workflow.slice(
      workflow.indexOf('      - name: 蓝绿部署 API'),
      workflow.indexOf('      - name: 持久化 API 与 Worker 操作回执'),
    );
    assert.match(appStep, /resume_handoff=true/u);
    assert.match(appStep, /RESUME_HANDOFF='\$resume_handoff'/u);
    assert.match(appStep, /app-handoff\.json/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

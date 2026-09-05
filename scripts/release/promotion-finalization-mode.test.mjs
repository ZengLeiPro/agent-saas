import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import {
  promotionFinalizationMode,
  finalizationDeploymentId,
} from './promotion-finalization-mode.mjs';

const manifest = {
  releaseId: 'rc-20260906-01',
  digest: 'sha256:' + 'a'.repeat(64),
  migrationPlan: { phase: 'expand', confirmation: 'required_after_observation' },
};
const entry = {
  releaseId: manifest.releaseId,
  manifestDigest: manifest.digest,
  state: 'awaiting_expand_confirmation',
};
const mode = (latest, rc = manifest, runId = '123') =>
  promotionFinalizationMode({ manifest: rc, attestations: [latest], runId });

test('正常发布继续部署，等待确认只进入自动收尾', () => {
  for (const state of [
    'verified',
    'approved',
    'promoting',
    'needs_human',
    'failed_before_change',
  ]) {
    assert.equal(mode({ ...entry, state }), 'promote');
  }
  assert.equal(mode(entry), 'confirm');
});

test('contract、非 expand 与跨 RC 的等待状态都不能进入自动收尾', () => {
  for (const phase of ['contract', 'none']) {
    assert.throws(
      () => mode(entry, { ...manifest, migrationPlan: { ...manifest.migrationPlan, phase } }),
      /requires an expand/,
    );
  }
  for (const field of ['releaseId', 'manifestDigest']) {
    assert.throws(() => mode({ ...entry, [field]: 'wrong' }), /bound to this RC/);
  }
});

test('已完成发布只允许同一 run 修复镜像，不能重复晋级或跨 run 补写', () => {
  const completed = { ...entry, state: 'completed', operationKey: 'expand-confirmation:123:1' };
  assert.equal(mode(completed), 'repair');
  for (const runId of ['124', '12.*', '', '0']) {
    assert.throws(() => mode(completed, manifest, runId), /another workflow run/);
  }
  assert.throws(
    () => mode({ ...completed, operationKey: 'outcome:123:1' }),
    /another workflow run/,
  );
});

test('收尾模式跳过全部部署动作，沿用生产锁与同一次审批', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/promote-release.yml', import.meta.url),
    'utf8',
  );
  const blocks = workflow.split(/(?=      - name: )/u);
  const first = blocks.findIndex((block) => block.includes('- name: Fail-closed revalidate'));
  const last = blocks.findIndex((block) => block.includes('- name: Record truthful final outcome'));
  for (const block of blocks.slice(first, last + 1)) {
    if (block.includes('- name: Configure production SSH')) continue;
    assert.match(block, /if: env\.PROMOTION_FINALIZATION_MODE == 'promote'/u, block.split('\n')[0]);
  }
  assert.match(
    workflow,
    /finalization_mode="\$\(node scripts\/release\/promotion-finalization-mode\.mjs/u,
  );
  assert.doesNotMatch(workflow, /echo "PROMOTION_FINALIZATION_MODE=\$\(node/u);
  assert.equal(workflow.match(/environment: production/gu)?.length, 1);
  assert.match(workflow, /awaiting_expand_confirmation\) state=in_progress/u);
  assert.match(workflow, /steps\.finalize_expand\.outcome.*success/u);
  assert.equal(
    existsSync(new URL('../../.github/workflows/confirm-expand-migration.yml', import.meta.url)),
    false,
  );
});

test('确认与镜像重跑恢复原 Production Deployment，成功后可更新原状态', () => {
  const awaiting = { ...entry, reason: JSON.stringify({ productionDeploymentId: '12345' }) };
  assert.equal(finalizationDeploymentId([awaiting, { ...entry, state: 'completed' }]), '12345');
  assert.equal(finalizationDeploymentId([entry]), '');
  for (const productionDeploymentId of ['12/34', '0', {}, 12345]) {
    assert.throws(
      () =>
        finalizationDeploymentId([
          { ...entry, reason: JSON.stringify({ productionDeploymentId }) },
        ]),
      /Invalid Production Deployment ID/,
    );
  }
});

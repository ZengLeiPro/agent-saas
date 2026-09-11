import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readEvidenceJson } from './evidence-file.mjs';
import { baselineFromCheckpoint } from './production-checkpoint.mjs';
import { hash, normalizedComponents, requireAutomatic } from './automatic-release-contract.mjs';

export function verifyProductionResult(checkpoint, expectedSource, expectedRelease, maintenance) {
  baselineFromCheckpoint(checkpoint);
  const { manifest } = checkpoint;
  requireAutomatic(
    manifest.releaseSha === expectedSource && manifest.releaseId === expectedRelease,
    'wrong_final_target',
    '恢复的旧版本不能代替本次请求的目标版本。',
  );
  assert.equal(
    hash(normalizedComponents(checkpoint.productionState.components)),
    hash(normalizedComponents(manifest.components)),
  );
  assert.equal(
    maintenance?.checkpoint,
    'success',
    'The committed checkpoint must be durably saved',
  );
  return {
    releaseId: manifest.releaseId,
    sourceSha: manifest.releaseSha,
    manifestDigest: manifest.digest,
    checkpointDigest: checkpoint.digest,
    observedAt: checkpoint.productionState.observedAt,
  };
}

export async function downloadResult(client, run, directory, prefix) {
  const artifacts = await client.pages(`actions/runs/${run.id}/artifacts`, 'artifacts');
  const selected = artifacts.filter((a) => a.name.startsWith(prefix) && !a.expired);
  requireAutomatic(
    selected.length === 1,
    'ambiguous_result',
    '子任务缺少唯一、未过期的结果证据，不能仅凭绿色状态继续。',
  );
  const artifact = selected[0];
  assert.equal(artifact.workflow_run?.id, run.id);
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  const out = join(directory, `result-${run.id}`);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length === 0)
    await client.gh([
      'run',
      'download',
      String(run.id),
      '--repo',
      client.repository,
      '--name',
      artifact.name,
      '--dir',
      out,
    ]);
  const latest = await client.api(`actions/runs/${run.id}`);
  assert.equal(latest.run_attempt, run.run_attempt);
  assert.equal(latest.status, 'completed');
  assert.equal(latest.conclusion, 'success');
  return out;
}

export async function productionResult(client, run, directory, source, release) {
  const out = await downloadResult(client, run, directory, `production-promotion-${release}-`);
  const maintenance = await readEvidenceJson(join(out, 'checkpoint-maintenance.json'));
  if (maintenance.checkpoint !== 'success') return { checkpointPending: true };
  const checkpoint = await readEvidenceJson(join(out, 'production-checkpoint.json'), 4194304);
  assert.equal(checkpoint.runId, run.id);
  assert.equal(checkpoint.runAttempt, run.run_attempt);
  const observedAt = Date.parse(checkpoint.productionState.observedAt);
  assert(
    observedAt >= Date.parse(run.run_started_at) - 60000 &&
      observedAt <= Date.parse(run.updated_at) + 60000,
    'Checkpoint must come from this child run',
  );
  const result = verifyProductionResult(checkpoint, source, release, maintenance);
  return { ...result, checkpointPending: false };
}

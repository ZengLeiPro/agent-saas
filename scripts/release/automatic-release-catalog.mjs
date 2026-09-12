import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readEvidenceJson, readEvidenceFile } from './evidence-file.mjs';
import { selectAttestationSnapshot } from './attestation-snapshot.mjs';
import { describeRelease } from './automatic-release-plan.mjs';
import { RC_PATTERN, requireAutomatic } from './automatic-release-contract.mjs';
import { SHA_PATTERN } from './artifact-lib.mjs';

export function isAncestor(older, newer) {
  assert(SHA_PATTERN.test(older ?? '') && SHA_PATTERN.test(newer ?? ''));
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer], {
      timeout: 10000,
      maxBuffer: 1024,
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error('Git ancestry is unavailable; refusing to guess version order');
  }
}

export async function readRelease(client, releaseId, directory, now = Date.now()) {
  assert(RC_PATTERN.test(releaseId));
  const metadata = await client.api(`releases/tags/${releaseId}`);
  requireAutomatic(
    !metadata.draft && metadata.tag_name === releaseId,
    'release_unavailable',
    '候选发布记录不可用。',
  );
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, `${releaseId}-`));
  await client.gh([
    'release',
    'download',
    releaseId,
    '--repo',
    client.repository,
    '--dir',
    root,
    '--pattern',
    'manifest.json',
    '--pattern',
    'attestation-*.jsonl',
  ]);
  const manifest = await readEvidenceJson(join(root, 'manifest.json'), 1048576);
  const paths = (await readdir(root)).filter((name) =>
    /^attestation-[0-9]+-[a-z_]+-[a-f0-9]{64}\.jsonl$/u.test(name),
  );
  requireAutomatic(
    paths.length > 0 && paths.length <= 1000,
    'missing_history',
    '候选缺少完整、可核验的发布历史。',
  );
  let totalBytes = 0;
  for (const name of paths) {
    totalBytes += (await readEvidenceFile(join(root, name), 4194304)).length;
    requireAutomatic(totalBytes <= 16 * 1024 * 1024, 'history_limit', '发布历史超出有界读取预算。');
  }
  const historyPath = join(root, 'history.jsonl');
  await selectAttestationSnapshot(
    paths.map((name) => join(root, name)),
    historyPath,
  );
  const history = (await readEvidenceFile(historyPath, 4194304))
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(manifest.releaseId, releaseId);
  return { ...describeRelease({ manifest, history }, now), root };
}

export async function loadCatalog(client, directory, now = Date.now()) {
  const releases = await client.pages('releases');
  const result = [];
  for (const release of releases) {
    if (release.draft || !RC_PATTERN.test(release.tag_name ?? '')) continue;
    // A draft/incomplete build has no accepted or mutated RC. Do not invent a candidate for it.
    if (
      !release.assets?.some((asset) => asset.name === 'manifest.json') ||
      !release.assets.some((asset) => asset.name.startsWith('attestation-'))
    )
      continue;
    result.push(await readRelease(client, release.tag_name, directory, now));
  }
  return result;
}

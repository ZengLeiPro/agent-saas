import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digestFile } from './artifact-lib.mjs';
import { sealInstalledRelease, verifyInstalledRelease } from './verify-installed-release.mjs';

test('recomputes the retained archive and extracted tree before reusing a release directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-release-'));
  await mkdir(join(root, '.release'));
  await mkdir(join(root, 'server'));
  await mkdir(join(root, 'acs-orchestrator'));
  await writeFile(join(root, '.release', 'server-bundle.tgz'), 'immutable archive');
  await writeFile(join(root, '.release', 'acs-orchestrator.tgz'), 'immutable ACS archive');
  await writeFile(join(root, 'server', 'dist.js'), 'running bytes');
  await writeFile(join(root, 'acs-orchestrator', 'dist.js'), 'running ACS bytes');
  const archive = await digestFile(join(root, '.release', 'server-bundle.tgz'));
  const acsArchive = await digestFile(join(root, '.release', 'acs-orchestrator.tgz'));
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      releaseId: 'rc-20260827-01',
      digest: `sha256:${'a'.repeat(64)}`,
      components: {
        api: { artifactDigest: archive.digest },
        acs: { orchestratorArtifactDigest: acsArchive.digest },
      },
    }),
  );
  await sealInstalledRelease(root, 'server');
  await sealInstalledRelease(root, 'acs');
  await assert.doesNotReject(verifyInstalledRelease(root, 'server'));
  await assert.doesNotReject(verifyInstalledRelease(root, 'acs'));
  await writeFile(join(root, 'server', 'dist.js'), 'mutated running bytes');
  await assert.rejects(verifyInstalledRelease(root, 'server'), /installed bytes/u);
});

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

export function verifyPromotionAcsSelection({ manifest, artifactIndex, expectedRepository }) {
  const acs = manifest.components?.acs;
  const baseline = manifest.productionBaseline?.acs;
  const orchestrator = manifest.artifacts?.acsOrchestrator;
  const image = manifest.artifacts?.acsImage;
  if (!acs || !baseline || !orchestrator || !image) {
    throw new Error('Release Manifest is missing the selected ACS identity');
  }
  requireEqual(
    image.repository,
    expectedRepository,
    'Selected ACS image repository is not allowed',
  );
  requireEqual(
    acs.orchestratorArtifactDigest,
    orchestrator.digest,
    'Selected ACS orchestrator disagrees with the component identity',
  );
  requireEqual(
    acs.sandboxImageDigest,
    image.digest,
    'Selected ACS image disagrees with the component identity',
  );

  if (acs.action === 'keep') {
    requireEqual(acs.sourceSha, baseline.sourceSha, 'Kept ACS source must equal the baseline');
    requireEqual(
      acs.orchestratorArtifactDigest,
      baseline.orchestratorArtifactDigest,
      'Kept ACS orchestrator must equal the baseline',
    );
    requireEqual(
      acs.sandboxImageDigest,
      baseline.sandboxImageDigest,
      'Kept ACS image must equal the baseline',
    );
    requireEqual(orchestrator.required, false, 'Kept ACS orchestrator must not be required');
    requireEqual(image.required, false, 'Kept ACS image must not be required');
    return;
  }
  if (acs.action !== 'deploy') throw new Error(`Unsupported ACS action: ${acs.action}`);

  requireEqual(acs.sourceSha, manifest.releaseSha, 'Deployed ACS source must equal releaseSha');
  requireEqual(orchestrator.required, true, 'Deployed ACS orchestrator must be required');
  requireEqual(image.required, true, 'Deployed ACS image must be required');
  const builtImage = artifactIndex.acsImage;
  if (!builtImage) throw new Error('ACS deploy requires an image in the built artifact index');
  requireEqual(builtImage.sourceSha, manifest.releaseSha, 'Built ACS image sourceSha is incorrect');
  requireEqual(builtImage.digest, image.digest, 'Built ACS image digest is incorrect');
  requireEqual(
    builtImage.reference,
    `${expectedRepository}@${image.digest}`,
    'Built ACS image reference is incorrect',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, artifactIndexPath, expectedRepository] = process.argv.slice(2);
  if (!manifestPath || !artifactIndexPath || !expectedRepository) {
    throw new Error(
      'usage: verify-promotion-acs-selection.mjs <manifest.json> <artifact-index.json> <expected-repository>',
    );
  }
  Promise.all([readFile(manifestPath, 'utf8'), readFile(artifactIndexPath, 'utf8')]).then(
    ([manifest, artifactIndex]) => {
      verifyPromotionAcsSelection({
        manifest: JSON.parse(manifest),
        artifactIndex: JSON.parse(artifactIndex),
        expectedRepository,
      });
    },
  );
}

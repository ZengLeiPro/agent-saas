import type {
  ReleaseComponent,
  ReleaseComponentMatrix,
  ReleaseManifest,
  ReleaseManifestContent,
} from '@agent/shared';
import { releaseManifestContentSchema } from '@agent/shared';
import { calculateManifestDigest } from './releaseManifestStore.js';

interface ArtifactEntry {
  uri: string;
  digest: string;
  size: number;
}

export interface ReleaseCandidateEvidence {
  releaseId: string;
  releaseSha: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  releasePullRequest?: ReleaseManifestContent['releasePullRequest'];
  integrationCandidates: ReleaseManifestContent['integrationCandidates'];
  sourcePullRequests: number[];
  checks: ReleaseManifestContent['checks'];
  productionBaseline: ReleaseComponentMatrix;
  affectedComponents: ReleaseComponent[];
  builtArtifacts: {
    serverBundle: ArtifactEntry;
    webAssets: ArtifactEntry;
    acsOrchestrator?: ArtifactEntry;
    acsImage?: { repository: string; digest: string };
  };
  baselineArtifacts: {
    serverBundle: ArtifactEntry;
    webAssets: ArtifactEntry;
    acsOrchestrator: ArtifactEntry;
    acsImage: { repository: string; digest: string };
  };
  migrationPlan: ReleaseManifestContent['migrationPlan'];
}

export function createReleaseCandidate(evidence: ReleaseCandidateEvidence): ReleaseManifest {
  const affected = new Set(evidence.affectedComponents);
  if (affected.has('api') !== affected.has('runtimeWorker')) {
    throw new Error('API and Runtime Worker must deploy or keep together');
  }
  const serverArtifact = affected.has('api')
    ? evidence.builtArtifacts.serverBundle
    : evidence.baselineArtifacts.serverBundle;
  const webArtifact = affected.has('web')
    ? evidence.builtArtifacts.webAssets
    : evidence.baselineArtifacts.webAssets;
  const acsArtifact = affected.has('acs')
    ? evidence.builtArtifacts.acsOrchestrator
    : evidence.baselineArtifacts.acsOrchestrator;
  const acsImage = affected.has('acs')
    ? evidence.builtArtifacts.acsImage
    : evidence.baselineArtifacts.acsImage;
  if (!acsArtifact || !acsImage) throw new Error('ACS deploy requires exact immutable artifacts');

  const components: ReleaseManifestContent['components'] = {
    web: {
      action: affected.has('web') ? 'deploy' : 'keep',
      sourceSha: affected.has('web')
        ? evidence.releaseSha
        : evidence.productionBaseline.web.sourceSha,
      artifactDigest: webArtifact.digest,
    },
    api: {
      action: affected.has('api') ? 'deploy' : 'keep',
      sourceSha: affected.has('api')
        ? evidence.releaseSha
        : evidence.productionBaseline.api.sourceSha,
      artifactDigest: serverArtifact.digest,
    },
    runtimeWorker: {
      action: affected.has('runtimeWorker') ? 'deploy' : 'keep',
      sourceSha: affected.has('runtimeWorker')
        ? evidence.releaseSha
        : evidence.productionBaseline.runtimeWorker.sourceSha,
      artifactDigest: serverArtifact.digest,
    },
    acs: {
      action: affected.has('acs') ? 'deploy' : 'keep',
      sourceSha: affected.has('acs')
        ? evidence.releaseSha
        : evidence.productionBaseline.acs.sourceSha,
      orchestratorArtifactDigest: acsArtifact.digest,
      sandboxImageDigest: acsImage.digest,
    },
  };
  const content = releaseManifestContentSchema.parse({
    schemaVersion: 1,
    releaseId: evidence.releaseId,
    releaseSha: evidence.releaseSha,
    tag: evidence.releaseId,
    createdAt: evidence.createdAt,
    createdBy: evidence.createdBy,
    ...(evidence.releasePullRequest ? { releasePullRequest: evidence.releasePullRequest } : {}),
    integrationCandidates: evidence.integrationCandidates,
    sourcePullRequests: [...evidence.sourcePullRequests].sort((left, right) => left - right),
    productionBaseline: evidence.productionBaseline,
    components,
    artifacts: {
      serverBundle: serverArtifact,
      webAssets: webArtifact,
      acsOrchestrator: { ...acsArtifact, required: affected.has('acs') },
      acsImage: { ...acsImage, required: affected.has('acs') },
    },
    checks: evidence.checks,
    promotionPolicy: {
      expiresAt: evidence.expiresAt,
      minimumPromotableSha: evidence.releaseSha,
      requiresHumanApproval: true,
    },
    migrationPlan: evidence.migrationPlan,
    rollbackTargets: evidence.productionBaseline,
  });
  return Object.freeze({ ...content, digest: calculateManifestDigest(content) });
}

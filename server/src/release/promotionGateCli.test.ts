import { describe, expect, it } from 'vitest';
import { baselineFromState, validateApprovalReason } from './promotionGateCli.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('promotion gate evidence', () => {
  it('projects only immutable component identity from production observations', () => {
    const component = { gitSha: SHA, artifactDigest: DIGEST, deployedAt: 'ignored' };
    expect(
      baselineFromState({
        components: {
          web: component,
          api: component,
          runtimeWorker: component,
          acs: {
            gitSha: SHA,
            orchestratorArtifactDigest: DIGEST,
            sandboxImageDigest: DIGEST,
          },
        },
      }),
    ).toEqual({
      web: { sourceSha: SHA, artifactDigest: DIGEST },
      api: { sourceSha: SHA, artifactDigest: DIGEST },
      runtimeWorker: { sourceSha: SHA, artifactDigest: DIGEST },
      acs: {
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
      },
    });
  });

  it('requires structured approval bound to the exact release and Manifest', () => {
    const valid = JSON.stringify({
      releaseId: 'rc-20260826-01',
      manifestDigest: DIGEST,
      stagingDeploymentId: '1',
      e2eRunId: '2',
      triggeredAt: '2026-08-26T00:00:00.000Z',
    });
    expect(
      validateApprovalReason(valid, { releaseId: 'rc-20260826-01', digest: DIGEST }),
    ).toMatchObject({
      e2eRunId: '2',
    });
    expect(() =>
      validateApprovalReason(valid, { releaseId: 'rc-20260826-02', digest: DIGEST }),
    ).toThrow(/not bound/u);
    expect(() =>
      validateApprovalReason('{}', { releaseId: 'rc-20260826-01', digest: DIGEST }),
    ).toThrow(/missing releaseId/u);
  });
});

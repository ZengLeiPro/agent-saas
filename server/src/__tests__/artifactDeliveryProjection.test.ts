import { describe, expect, it } from 'vitest';

import { projectArtifactDelivery } from '../channels/web/artifactDeliveryProjection.js';

describe('Artifact delivery projection', () => {
  it('falls back to the bounded deliver payload when metadata is missing', () => {
    expect(projectArtifactDelivery('Artifact', undefined, JSON.stringify({
      action: 'deliver',
      artifactId: 'artifact_fallback',
      kind: 'log',
      fileName: '执行日志.txt',
      sizeBytes: 32,
      mimeType: 'text/plain',
    }))).toEqual({
      type: 'artifact_created',
      artifactId: 'artifact_fallback',
      fileName: '执行日志.txt',
      kind: 'log',
      sizeBytes: 32,
      mimeType: 'text/plain',
    });
  });

  it('does not project create payloads or malformed deliver payloads', () => {
    expect(projectArtifactDelivery('Artifact', undefined, JSON.stringify({
      action: 'create', artifactId: 'artifact_create', kind: 'file', fileName: 'a.txt',
    }))).toBeNull();
    expect(projectArtifactDelivery('Artifact', undefined, JSON.stringify({
      action: 'deliver', artifactId: 'artifact_missing_kind', fileName: 'a.txt',
    }))).toBeNull();
  });
});

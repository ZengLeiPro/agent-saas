import { describe, expect, it } from 'vitest';
import type { ArtifactReadGrant } from '@agent/shared';
import { mobileArtifactWarning, selectMobileArtifactViewer } from './artifactViewAdapter';

const grant = (viewKind: ArtifactReadGrant['descriptor']['viewKind'], requiresWarning = false): ArtifactReadGrant => ({
  readUrl: 'https://api.example.test/api/artifacts/a/content?token=secret',
  descriptor: {
    artifactId: 'a', name: 'report.bin', safeMime: 'application/octet-stream', size: 2048,
    digest: 'a'.repeat(64), viewKind, activeContent: requiresWarning, requiresWarning,
    expiresAt: '2030-01-01T00:00:00.000Z', correlationId: 'corr',
  },
});

describe('M50-02 Mobile Artifact safe-view parity', () => {
  it.each([
    ['image', 'native-image'], ['pdf', 'native-pdf'], ['markdown', 'native-text'],
    ['html', 'download-only'], ['text', 'native-text'], ['source', 'native-text'],
    ['audio', 'native-audio'], ['video', 'native-video'], ['download-only', 'download-only'],
  ] as const)('maps %s without WebView execution', (kind, expected) => {
    expect(selectMobileArtifactViewer(grant(kind))).toBe(expected);
  });

  it('shows accessible active-content warning details without signed URL', () => {
    const warning = mobileArtifactWarning(grant('download-only', true));
    expect(warning).toContain('类型：application/octet-stream');
    expect(warning).toContain('大小：2.0 KB');
    expect(warning).toContain('来源：当前会话 Artifact');
    expect(warning).not.toContain('token=');
  });
});

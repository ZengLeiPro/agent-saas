import { describe, expect, it } from 'vitest';
import {
  createArtifactViewerState,
  evaluateArtifactPolicy,
  parseArtifactReadGrant,
  reduceArtifactViewer,
} from './artifactViewModel';

const base = {
  artifactId: 'artifact_1',
  name: 'file.bin',
  size: 8,
  digest: 'a'.repeat(64),
  expiresAt: '2030-01-01T00:00:00.000Z',
  correlationId: 'corr-1',
};

const bytes = (value: string) => new TextEncoder().encode(value);

describe('M50-02 canonical artifact policy', () => {
  it('allows only MIME and magic matched passive formats inline', () => {
    expect(evaluateArtifactPolicy({ ...base, name: 'x.png', declaredMime: 'image/png', bytes: Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }).viewKind).toBe('image');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.pdf', declaredMime: 'application/pdf', bytes: bytes('%PDF-1.7\n1 0 obj') }).viewKind).toBe('pdf');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.txt', declaredMime: 'text/plain', bytes: bytes('safe text') }).viewKind).toBe('text');
  });

  it.each([
    ['mime spoof', { name: 'x.png', declaredMime: 'image/png', bytes: bytes('<svg><script>x</script></svg>') }],
    ['double extension', { name: 'invoice.html.png', declaredMime: 'image/png', bytes: Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }],
    ['html', { name: 'x.html', declaredMime: 'text/html', bytes: bytes('<!doctype html><script>x</script>') }],
    ['svg', { name: 'x.svg', declaredMime: 'image/svg+xml', bytes: bytes('<svg/>') }],
    ['pdf javascript', { name: 'x.pdf', declaredMime: 'application/pdf', bytes: bytes('%PDF-1.7 /JavaScript /JS') }],
    ['executable', { name: 'x.txt', declaredMime: 'text/plain', bytes: Uint8Array.from([0x4d, 0x5a, 1, 2]) }],
    ['macro document', { name: 'x.docm', declaredMime: 'application/vnd.ms-word.document.macroEnabled.12', bytes: bytes('PK') }],
  ])('fails %s closed to warned attachment', (_label, input) => {
    const result = evaluateArtifactPolicy({ ...base, ...input });
    expect(result).toMatchObject({ viewKind: 'download-only', disposition: 'attachment', requiresWarning: true });
  });

  it('rejects malformed descriptors instead of accepting URL/path/html fallbacks', () => {
    expect(parseArtifactReadGrant({ readUrl: 'https://evil.test/x', descriptor: { artifactId: 'x' } })).toBeNull();
    expect(parseArtifactReadGrant({ url: 'https://evil.test/x', path: '/tmp/x', html: '<script />' })).toBeNull();
  });
});

describe('M50-02 cross-platform artifact viewer state', () => {
  it('refreshes expiry at most once and preserves position', () => {
    let state = reduceArtifactViewer(createArtifactViewerState(), { type: 'open', artifactId: 'artifact_1', ownerKey: 'tenant:user' });
    state = reduceArtifactViewer(state, { type: 'position', position: { scrollTop: 120, page: 3, mediaTime: 42 } });
    state = reduceArtifactViewer(state, { type: 'expired' });
    expect(state).toMatchObject({ status: 'refreshing', refreshCount: 1, position: { scrollTop: 120, page: 3, mediaTime: 42 } });
    state = reduceArtifactViewer(state, { type: 'expired' });
    expect(state).toMatchObject({ status: 'error', refreshCount: 1, error: { code: 'authentication_required' } });
  });

  it('clears the viewer on owner switch', () => {
    const opened = reduceArtifactViewer(createArtifactViewerState(), { type: 'open', artifactId: 'artifact_1', ownerKey: 'a' });
    expect(reduceArtifactViewer(opened, { type: 'owner-switched', ownerKey: 'b' })).toEqual(createArtifactViewerState());
  });
});

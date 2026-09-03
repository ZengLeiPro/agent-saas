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
  it('allows verified passive formats plus safely rendered text families inline', () => {
    expect(evaluateArtifactPolicy({ ...base, name: 'x.png', declaredMime: 'image/png', bytes: Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }).viewKind).toBe('image');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.pdf', declaredMime: 'application/pdf', bytes: bytes('%PDF-1.7\n1 0 obj') }).viewKind).toBe('pdf');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.txt', declaredMime: 'text/plain', bytes: bytes('safe text') }).viewKind).toBe('text');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.md', bytes: bytes('# Markdown') })).toMatchObject({ viewKind: 'markdown', activeContent: false });
    expect(evaluateArtifactPolicy({ ...base, name: 'x.json', declaredMime: 'application/json', bytes: bytes('{"ok":true}') })).toMatchObject({ viewKind: 'source', activeContent: false });
    expect(evaluateArtifactPolicy({ ...base, name: 'x.html', declaredMime: 'text/html', bytes: bytes('<!doctype html><script>x</script>') })).toMatchObject({ viewKind: 'html', activeContent: true, requiresWarning: true });
    expect(evaluateArtifactPolicy({ ...base, name: 'x.svg', declaredMime: 'image/svg+xml', bytes: bytes('<svg/>') })).toMatchObject({ viewKind: 'source', activeContent: true, requiresWarning: true });
    expect(evaluateArtifactPolicy({ ...base, name: 'x.sh', declaredMime: 'text/plain', bytes: bytes('#!/bin/sh\necho ok') })).toMatchObject({ viewKind: 'source', activeContent: true, requiresWarning: true });
    expect(evaluateArtifactPolicy({ ...base, name: 'x.py', bytes: bytes('print("ok")') })).toMatchObject({ viewKind: 'source', activeContent: true, requiresWarning: true });
    expect(evaluateArtifactPolicy({ ...base, name: 'links.pdf', declaredMime: 'application/pdf', bytes: bytes('%PDF-1.7 /URI (https://example.com)') }).viewKind).toBe('pdf');
  });

  it.each([
    ['mime spoof', { name: 'x.png', declaredMime: 'image/png', bytes: bytes('<svg><script>x</script></svg>') }],
    ['double extension', { name: 'invoice.html.png', declaredMime: 'image/png', bytes: Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) }],
    ['pdf javascript', { name: 'x.pdf', declaredMime: 'application/pdf', bytes: bytes('%PDF-1.7 /JavaScript /JS') }],
    ['executable', { name: 'x.txt', declaredMime: 'text/plain', bytes: Uint8Array.from([0x4d, 0x5a, 1, 2]) }],
    ['macro document', { name: 'x.docm', declaredMime: 'application/vnd.ms-word.document.macroEnabled.12', bytes: bytes('PK') }],
    ['archive', { name: 'x.zip', declaredMime: 'application/zip', bytes: bytes('PK') }],
  ])('fails %s closed to warned attachment', (_label, input) => {
    const result = evaluateArtifactPolicy({ ...base, ...input });
    expect(result).toMatchObject({ viewKind: 'download-only', disposition: 'attachment', requiresWarning: true });
  });

  it('keeps normal Office downloads warning-free until a safe converter exists', () => {
    expect(evaluateArtifactPolicy({
      ...base,
      name: 'x.docx',
      declaredMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: bytes('PK'),
    })).toMatchObject({ viewKind: 'download-only', disposition: 'attachment', requiresWarning: false, reason: 'conversion-required' });
  });

  it('rejects declared MIME and extension spoofing', () => {
    expect(evaluateArtifactPolicy({ ...base, name: 'x.md', declaredMime: 'image/png', bytes: bytes('# text') }).viewKind).toBe('download-only');
    expect(evaluateArtifactPolicy({ ...base, name: 'x.png', declaredMime: 'text/plain', bytes: bytes('not an image') }).viewKind).toBe('download-only');
  });

  it('rejects malformed descriptors instead of accepting URL/path/html fallbacks', () => {
    expect(parseArtifactReadGrant({ readUrl: 'https://evil.test/x', descriptor: { artifactId: 'x' } })).toBeNull();
    expect(parseArtifactReadGrant({ url: 'https://evil.test/x', path: '/tmp/x', html: '<script />' })).toBeNull();
  });
});

describe('M50-02 cross-platform artifact viewer state', () => {
  it('refreshes a resource token at most once, preserves position and never requests sign-in', () => {
    let state = reduceArtifactViewer(createArtifactViewerState(), { type: 'open', artifactId: 'artifact_1', ownerKey: 'tenant:user' });
    state = reduceArtifactViewer(state, { type: 'position', position: { scrollTop: 120, page: 3, mediaTime: 42 } });
    state = reduceArtifactViewer(state, { type: 'expired' });
    expect(state).toMatchObject({ status: 'refreshing', refreshCount: 1, position: { scrollTop: 120, page: 3, mediaTime: 42 } });
    state = reduceArtifactViewer(state, { type: 'expired' });
    expect(state).toMatchObject({
      status: 'error',
      refreshCount: 1,
      error: { code: 'artifact_link_expired', message: '文件链接已失效，请重试。', action: 'close' },
    });
  });

  it('clears the viewer on owner switch', () => {
    const opened = reduceArtifactViewer(createArtifactViewerState(), { type: 'open', artifactId: 'artifact_1', ownerKey: 'a' });
    expect(reduceArtifactViewer(opened, { type: 'owner-switched', ownerKey: 'b' })).toEqual(createArtifactViewerState());
  });
});

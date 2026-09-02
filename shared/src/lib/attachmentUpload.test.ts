import { describe, expect, it } from 'vitest';
import {
  assertNoLocalAttachmentReference,
  createAttachmentUploadIntent,
  recoverAttachmentUploadIntent,
  reduceAttachmentUpload,
  selectAttachmentRenderCard,
  validateAttachmentSelection,
} from './attachmentUpload';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const selected = () => createAttachmentUploadIntent({
  localIntentId: 'intent-1', uploadRequestId: REQUEST, name: 'photo.png', size: 8, mimeType: 'image/png',
});

describe('M50-03 attachment upload state machine', () => {
  it('uses stable intent/request identity and monotonic progress', () => {
    let state = reduceAttachmentUpload(selected(), { type: 'validate' });
    state = reduceAttachmentUpload(state, { type: 'validation_passed' });
    state = reduceAttachmentUpload(state, { type: 'progress', value: 0.7 });
    state = reduceAttachmentUpload(state, { type: 'progress', value: 0.2 });
    expect(state).toMatchObject({ localIntentId: 'intent-1', uploadRequestId: REQUEST, status: 'uploading', progress: 0.7 });
    state = reduceAttachmentUpload(state, { type: 'server_uploaded', attachmentId: ID });
    expect(state).toMatchObject({ status: 'uploaded', progress: 1, attachmentId: ID });
  });

  it('links retry attempts and makes late server success authoritative over cancel', () => {
    let state = reduceAttachmentUpload(selected(), { type: 'cancel' });
    state = reduceAttachmentUpload(state, { type: 'retry_same_request' });
    expect(state).toMatchObject({ uploadRequestId: REQUEST, attempt: 2, status: 'uploading' });
    state = reduceAttachmentUpload(state, { type: 'cancel' });
    state = reduceAttachmentUpload(state, { type: 'server_uploaded', attachmentId: ID });
    expect(state.status).toBe('uploaded');

    const next = reduceAttachmentUpload(
      reduceAttachmentUpload(selected(), { type: 'cancel' }),
      { type: 'retry_new_request', uploadRequestId: ID },
    );
    expect(next).toMatchObject({ uploadRequestId: ID, retryOfRequestId: REQUEST, attempt: 2 });
  });

  it.each(['offline', 'locked', 'identity_boundary'] as const)('fences unfinished upload on %s', (reason) => {
    const state = reduceAttachmentUpload(selected(), { type: 'fence', reason });
    expect(state).toMatchObject({ status: 'cancelled', errorCode: reason, requiresReselection: true });
  });

  it('recovers only server uploaded snapshots after kill and never silently resubmits local intent', () => {
    expect(recoverAttachmentUploadIntent(selected())).toMatchObject({ status: 'failed', errorCode: 'local_source_lost', requiresReselection: true });
    expect(recoverAttachmentUploadIntent(selected(), { attachmentId: ID, name: 'photo.png', size: 8, mimeType: 'image/png' }))
      .toMatchObject({ status: 'uploaded', attachmentId: ID, progress: 1 });
  });
});

describe('M50-03 attachment validation and leak guard', () => {
  it('rejects count, size, dangerous/double names and MIME mismatch before upload', () => {
    expect(validateAttachmentSelection(Array.from({ length: 21 }, (_, i) => ({ name: `a${i}.txt`, size: 1, mimeType: 'text/plain' })))).toMatchObject({ ok: false, issue: { code: 'count_exceeded' } });
    expect(validateAttachmentSelection([{ name: 'big.pdf', size: 11, mimeType: 'application/pdf' }], { maxBytes: 10 })).toMatchObject({ ok: false, issue: { code: 'size_exceeded' } });
    expect(validateAttachmentSelection([{ name: '../a.txt', size: 1, mimeType: 'text/plain' }])).toMatchObject({ ok: false, issue: { code: 'dangerous_filename' } });
    expect(validateAttachmentSelection([{ name: 'invoice.pdf.exe', size: 1, mimeType: 'application/pdf' }])).toMatchObject({ ok: false, issue: { code: 'double_extension' } });
    expect(validateAttachmentSelection([{ name: 'photo.png', size: 1, mimeType: 'text/plain' }])).toMatchObject({ ok: false, issue: { code: 'mime_extension_mismatch' } });
    expect(validateAttachmentSelection([{ name: 'x.svg', size: 1, mimeType: 'image/svg+xml' }])).toMatchObject({ ok: false, issue: { code: 'extension_blocked' } });
  });

  it('guards every durable/log/analytics/WS/queue projection from local paths', () => {
    expect(() => assertNoLocalAttachmentReference({ attachmentId: ID, name: 'ok.pdf' })).not.toThrow();
    for (const payload of [
      { uri: 'file:///private/a.png' },
      { display: { previewUrl: 'blob:abc' } },
      { analytics: { value: 'content://picker/a' } },
      { queue: { path: '/Users/alice/a.pdf' } },
    ]) expect(() => assertNoLocalAttachmentReference(payload)).toThrow(/Local attachment reference/);
  });

  it('renders only safe raster images as preview/fullscreen and files as download cards', () => {
    expect(selectAttachmentRenderCard({ attachmentId: ID, name: 'a.png', mimeType: 'image/png', size: 8 })).toMatchObject({ kind: 'image', canPreview: true, canFullscreen: true });
    expect(selectAttachmentRenderCard({ attachmentId: ID, name: 'a.svg', mimeType: 'image/svg+xml', size: 8 })).toMatchObject({ kind: 'file', canPreview: false, canDownload: true });
    expect(selectAttachmentRenderCard({ name: 'a.pdf', mimeType: 'application/pdf', status: 'failed' })).toMatchObject({ kind: 'file', canRetry: true, canRemove: true, canDownload: false });
  });
});

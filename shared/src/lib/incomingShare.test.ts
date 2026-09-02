import { describe, expect, it } from 'vitest';
import {
  INCOMING_SHARE_MAX_TOTAL_BYTES,
  assertIncomingSharePathFree,
  createIncomingShare,
  incomingShareUploadedAttachments,
  mergeIncomingShareText,
  reduceAttachmentDraft,
  shareError,
  validateIncomingShareMagic,
  validateIncomingShareSelection,
} from './incomingShare';

const attachment = (size: number, name = 'a.pdf', mimeType = 'application/pdf') => ({ name, size, mimeType });
const draft = () => createIncomingShare({
  intentId: 'intent-1',
  text: 'preserved composer',
  attachments: [{ draftId: 'draft-1', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'pdf', ...attachment(10) }],
  now: 0,
}).attachments[0];

describe('M50-01 canonical incoming share', () => {
  it('accepts exactly 20 MB, rejects 20 MB + 1, zero, and 6 items', () => {
    expect(validateIncomingShareSelection([attachment(INCOMING_SHARE_MAX_TOTAL_BYTES)])).toMatchObject({ ok: true });
    expect(validateIncomingShareSelection([attachment(INCOMING_SHARE_MAX_TOTAL_BYTES + 1)])).toMatchObject({ ok: false, error: { code: 'share_total_size_exceeded' } });
    expect(validateIncomingShareSelection([attachment(0)])).toMatchObject({ ok: false, error: { code: 'share_empty_file' } });
    expect(validateIncomingShareSelection(Array.from({ length: 5 }, (_, index) => attachment(1, `a${index}.pdf`)))).toMatchObject({ ok: true });
    expect(validateIncomingShareSelection(Array.from({ length: 6 }, (_, index) => attachment(1, `a${index}.pdf`)))).toMatchObject({ ok: false, error: { code: 'share_count_exceeded' } });
  });

  it('rejects MIME spoof, double extension and active content magic', () => {
    expect(validateIncomingShareSelection([attachment(4, 'photo.png', 'application/pdf')])).toMatchObject({ ok: false, error: { code: 'share_mime_mismatch' } });
    expect(validateIncomingShareSelection([attachment(4, 'invoice.exe.pdf')])).toMatchObject({ ok: false, error: { code: 'share_active_content' } });
    expect(validateIncomingShareMagic('application/pdf', new TextEncoder().encode('%PDF-1.7\nhello'))).toBe(true);
    expect(validateIncomingShareMagic('application/pdf', new TextEncoder().encode('%PDF-1.7<script>bad'))).toBe(false);
    expect(validateIncomingShareMagic('image/png', new TextEncoder().encode('%PDF-1.7'))).toBe(false);
  });

  it('uses the authoritative lifecycle and retries with the same requestId', () => {
    let state = reduceAttachmentDraft(draft(), { type: 'validate' });
    state = reduceAttachmentDraft(state, { type: 'validation_passed' });
    state = reduceAttachmentDraft(state, { type: 'upload_started' });
    state = reduceAttachmentDraft(state, { type: 'failed', error: shareError('share_offline', true, false, 'offline') });
    state = reduceAttachmentDraft(state, { type: 'retry' });
    expect(state).toMatchObject({ status: 'staging', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    state = reduceAttachmentDraft(state, { type: 'upload_started' });
    state = reduceAttachmentDraft(state, { type: 'uploaded', attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(state).toMatchObject({ status: 'uploaded', attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  });

  it('retains shared text on attachment failure and projects attachmentId-only submission', () => {
    const share = createIncomingShare({
      intentId: 'same-intent', text: 'do not lose this',
      attachments: [{ draftId: 'draft-1', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'pdf', ...attachment(10) }],
    });
    share.attachments[0] = reduceAttachmentDraft(share.attachments[0], { type: 'uploaded', attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(share.text).toBe('do not lose this');
    expect(mergeIncomingShareText('original composer', share.text)).toBe('original composer\ndo not lose this');
    const projection = incomingShareUploadedAttachments(share);
    expect(projection).toEqual([{ attachmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', display: { originalName: 'a.pdf', mimeType: 'application/pdf', size: 10, isImage: false } }]);
    expect(JSON.stringify(projection)).not.toMatch(/path|uri|requestId|draftId/i);
    for (const key of ['savedPath', 'absolutePath', 'displayPath']) {
      expect(() => assertIncomingSharePathFree({ [key]: '/tmp/a.pdf' })).toThrow();
    }
  });
});

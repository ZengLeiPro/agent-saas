import { describe, expect, it } from 'vitest';

import { buildMobileChatSubmission, toMobileChatWireMessage, validateMobileUploadedFiles } from './chatSubmissionAdapter';

const IMAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PDF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const image = {
  attachmentId: IMAGE_ID,
  originalName: '系统分享图片.jpg',
  savedPath: '/private/var/mobile/share.jpg',
  relativePath: 'uploads/share.jpg',
  size: 123,
  mimeType: 'image/jpeg',
  isImage: true,
};
const pdf = {
  attachmentId: PDF_ID,
  originalName: '普通附件.pdf',
  savedPath: '/data/user/0/cache/file.pdf',
  relativePath: 'uploads/file.pdf',
  size: 456,
  mimeType: 'application/pdf',
  isImage: false,
};

describe('M20-01 Mobile chat submission adapter', () => {
  it('keeps upload IDs identical for image/PDF/share and multiple attachments', () => {
    const result = buildMobileChatSubmission({
      text: '来自系统分享',
      clientMsgId: 'mobile-client-1',
      target: { sessionId: 'mobile-session' },
      deliveryMode: 'queue',
      model: 'mobile/model',
      attachments: [image, pdf],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.attachments.map((item) => item.attachmentId)).toEqual([IMAGE_ID, PDF_ID]);
    const wire = toMobileChatWireMessage(result.value);
    expect(wire.submission.attachments.map((item) => item.attachmentId)).toEqual([IMAGE_ID, PDF_ID]);
    expect(JSON.stringify(wire)).not.toMatch(/savedPath|relativePath|private\/var|data\/user/);
  });

  it('fails closed when a successful upload response has no usable ID', () => {
    expect(validateMobileUploadedFiles([{ ...image, attachmentId: undefined }]))
      .toMatchObject({ ok: false, issue: { code: 'attachment_id_missing' } });
    expect(validateMobileUploadedFiles([{ ...image, attachmentId: 'fake-id' }]))
      .toMatchObject({ ok: false, issue: { code: 'attachment_id_invalid' } });
  });
});

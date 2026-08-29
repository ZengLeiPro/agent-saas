import { describe, expect, it } from 'vitest';

import {
  CHAT_SUBMISSION_V1_CAPABILITY,
  canonicalChatAttachmentToDisplay,
  normalizeChatSubmission,
  parseCanonicalChatSubmission,
  toCanonicalChatSubmissionWireMessage,
} from './chatSubmission';

const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const PDF_ID = '22222222-2222-4222-8222-222222222222';

function sourceAttachment(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: IMAGE_ID,
    originalName: '相册图片.png',
    mimeType: 'image/png',
    size: 42,
    isImage: true,
    relativePath: 'uploads/server-path.png',
    savedPath: '/Users/alice/private/server-path.png',
    uri: 'file:///data/user/0/app/cache/private.png',
    ...overrides,
  };
}

describe('M20-01 canonical chat submission', () => {
  it('normalizes text/session/target/model and multiple image/PDF attachments by attachmentId', () => {
    const result = normalizeChatSubmission({
      text: '请比较这两个附件',
      clientMsgId: 'client-1',
      target: { sessionId: 'session-1', sandboxProfile: 'coding', orgAgentId: 'agent-1' },
      deliveryMode: 'steer',
      model: 'group/model',
      attachments: [
        sourceAttachment(),
        sourceAttachment({
          attachmentId: PDF_ID,
          originalName: '需求.pdf',
          mimeType: 'application/pdf',
          size: 2048,
          isImage: false,
          relativePath: 'uploads/需求.pdf',
          savedPath: '/tmp/需求.pdf',
        }),
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        text: '请比较这两个附件',
        clientMsgId: 'client-1',
        target: { sessionId: 'session-1', sandboxProfile: 'coding', orgAgentId: 'agent-1' },
        deliveryMode: 'steer',
        model: 'group/model',
        attachments: [
          {
            attachmentId: IMAGE_ID,
            display: { originalName: '相册图片.png', mimeType: 'image/png', size: 42, isImage: true },
          },
          {
            attachmentId: PDF_ID,
            display: { originalName: '需求.pdf', mimeType: 'application/pdf', size: 2048, isImage: false },
          },
        ],
      },
    });
  });

  it('fails closed for missing and malformed attachmentId', () => {
    expect(normalizeChatSubmission({
      text: 'x', clientMsgId: 'client-1', attachments: [sourceAttachment({ attachmentId: undefined })],
    })).toMatchObject({ ok: false, issue: { code: 'attachment_id_missing', attachmentIndex: 0 } });

    expect(normalizeChatSubmission({
      text: 'x', clientMsgId: 'client-1', attachments: [sourceAttachment({ attachmentId: 'uploads/fake.pdf' })],
    })).toMatchObject({ ok: false, issue: { code: 'attachment_id_invalid', attachmentIndex: 0 } });
  });

  it('allows attachment-only chat but rejects a truly empty submission', () => {
    expect(normalizeChatSubmission({
      text: '', clientMsgId: 'client-1', attachments: [sourceAttachment()],
    }).ok).toBe(true);
    expect(normalizeChatSubmission({ text: '   ', clientMsgId: 'client-1', attachments: [] }))
      .toMatchObject({ ok: false, issue: { code: 'empty_submission' } });
  });

  it('builds a path-free capture DTO even when upload sources contain absolute/local paths', () => {
    const normalized = normalizeChatSubmission({
      text: '看附件',
      clientMsgId: 'client-1',
      target: { sessionId: 'session-1' },
      attachments: [sourceAttachment()],
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const wire = toCanonicalChatSubmissionWireMessage(normalized.value, ['replaceable_drafts']);
    const capture = JSON.stringify(wire);
    expect(wire.clientCapabilities).toEqual([CHAT_SUBMISSION_V1_CAPABILITY, 'replaceable_drafts']);
    expect(capture).not.toMatch(/savedPath|relativePath|absolutePath|file:\/\/|Users\/alice|\/tmp\//);
    expect(wire.submission.attachments[0].attachmentId).toBe(IMAGE_ID);
  });

  it('strict wire parser rejects path keys rather than silently persisting them', () => {
    const value = {
      version: 1,
      text: 'x',
      clientMsgId: 'client-1',
      target: {},
      deliveryMode: 'queue',
      attachments: [{
        attachmentId: IMAGE_ID,
        display: { originalName: 'x.png' },
        relativePath: 'uploads/x.png',
      }],
    };
    expect(parseCanonicalChatSubmission(value)).toMatchObject({
      ok: false,
      issue: { code: 'attachment_path_forbidden', attachmentIndex: 0 },
    });
  });

  it('projects only ID plus display metadata for queue/replay UI', () => {
    expect(canonicalChatAttachmentToDisplay({
      attachmentId: PDF_ID,
      display: { originalName: 'share.pdf', mimeType: 'application/pdf', size: 99, isImage: false },
    })).toEqual({
      attachmentId: PDF_ID,
      name: 'share.pdf',
      mimeType: 'application/pdf',
      size: 99,
      isImage: false,
    });
  });
});

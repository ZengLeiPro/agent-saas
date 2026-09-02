import { describe, expect, it } from 'vitest';

import { buildWebChatSubmission, toWebChatWireMessage } from './chatSubmissionAdapter';

const ATTACHMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('M20-01 Web chat submission adapter', () => {
  it('uses shared canonical DTO instead of a second path-based submission shape', () => {
    const result = buildWebChatSubmission({
      text: 'web',
      clientMsgId: 'web-client-1',
      target: { sessionId: 'web-session' },
      deliveryMode: 'queue',
      attachments: [{
        attachmentId: ATTACHMENT_ID,
        originalName: 'web.pdf',
        mimeType: 'application/pdf',
        size: 100,
        isImage: false,
        relativePath: 'uploads/web.pdf',
        savedPath: '/srv/private/web.pdf',
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wire = toWebChatWireMessage(result.value);
    expect(wire.submission.attachments[0].attachmentId).toBe(ATTACHMENT_ID);
    expect(wire.clientCapabilities).toContain('chat_submission_v1');
    expect(wire.clientCapabilities).toContain('replaceable_drafts');
    expect(JSON.stringify(wire)).not.toMatch(/savedPath|relativePath|\/srv\/private/);
  });
});

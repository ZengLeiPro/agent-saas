import { describe, expect, it } from 'vitest';

import {
  MESSAGE_FEEDBACK_COMMENT_MAX,
  buildGuardrailAppealPayload,
  buildMessageFeedbackPayload,
  guardrailAppealFailureCopy,
  guardrailAppealOutcome,
  messageFeedbackOutcome,
  messageFeedbackSessionPath,
  parseSubmittedFeedbackHashes,
} from './messageFeedback';

describe('messageFeedbackSessionPath', () => {
  it('对 sessionId 做 URL 编码', () => {
    expect(messageFeedbackSessionPath('a/b')).toBe('/api/feedback/session/a%2Fb');
  });
});

describe('buildMessageFeedbackPayload', () => {
  it('空白评论不进 body', () => {
    expect(
      buildMessageFeedbackPayload({ sessionId: 's', messageId: 'm', content: 'c', comment: '   ' }),
    ).toEqual({ sessionId: 's', messageId: 'm', content: 'c' });
    expect(buildMessageFeedbackPayload({ sessionId: 's', messageId: 'm', content: 'c' })).toEqual({
      sessionId: 's',
      messageId: 'm',
      content: 'c',
    });
  });

  it('评论 trim 后按服务端上限截断', () => {
    const payload = buildMessageFeedbackPayload({
      sessionId: 's',
      messageId: 'm',
      content: 'c',
      comment: ` ${'x'.repeat(600)} `,
    });
    expect(payload.comment).toHaveLength(MESSAGE_FEEDBACK_COMMENT_MAX);
  });

  it('content 原样透传（服务端要按 sha256 比对 transcript）', () => {
    expect(
      buildMessageFeedbackPayload({ sessionId: 's', messageId: 'm', content: '  留白很重要  ' })
        .content,
    ).toBe('  留白很重要  ');
  });
});

describe('parseSubmittedFeedbackHashes', () => {
  it('只取合法字符串 hash', () => {
    expect(
      parseSubmittedFeedbackHashes({
        items: [{ contentHash: 'a' }, { contentHash: '' }, { contentHash: 1 }, null, 'x', {}],
      }),
    ).toEqual(['a']);
  });

  it('结构不符时返回空数组', () => {
    expect(parseSubmittedFeedbackHashes(null)).toEqual([]);
    expect(parseSubmittedFeedbackHashes({ items: 'x' })).toEqual([]);
    expect(parseSubmittedFeedbackHashes([])).toEqual([]);
  });
});

describe('messageFeedbackOutcome', () => {
  it('503 判为数据面不可用，入口隐藏', () => {
    expect(messageFeedbackOutcome(503)).toBe('disabled');
  });
  it('2xx 成功，其余失败', () => {
    expect(messageFeedbackOutcome(200)).toBe('ok');
    expect(messageFeedbackOutcome(204)).toBe('ok');
    expect(messageFeedbackOutcome(400)).toBe('failed');
    expect(messageFeedbackOutcome(500)).toBe('failed');
  });
});

describe('guardrail 申诉', () => {
  it('空白理由不进 body，超长截断', () => {
    expect(buildGuardrailAppealPayload({ guardrailEventId: 'e1', appealReason: ' ' })).toEqual({
      guardrailEventId: 'e1',
    });
    expect(
      buildGuardrailAppealPayload({ guardrailEventId: 'e1', appealReason: 'y'.repeat(700) })
        .appealReason,
    ).toHaveLength(MESSAGE_FEEDBACK_COMMENT_MAX);
  });

  it('409 幂等命中视为已申诉', () => {
    expect(guardrailAppealOutcome(409)).toBe('submitted');
    expect(guardrailAppealOutcome(201)).toBe('submitted');
    expect(guardrailAppealOutcome(503)).toBe('unavailable');
    expect(guardrailAppealOutcome(500)).toBe('failed');
  });

  it('失败文案与 web 现状一致', () => {
    expect(guardrailAppealFailureCopy('unavailable')).toBe('申诉服务暂不可用');
    expect(guardrailAppealFailureCopy('failed')).toBe('提交失败，请稍后重试');
    expect(guardrailAppealFailureCopy('submitted')).toBeNull();
  });
});

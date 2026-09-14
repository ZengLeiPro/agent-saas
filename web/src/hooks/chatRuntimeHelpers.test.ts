import { describe, expect, it } from 'vitest';
import { buildStreamStartedResume, shouldAdvanceDurableCursor } from './chatRuntimeHelpers';

describe('shouldAdvanceDurableCursor', () => {
  it('空游标时接受任何新值', () => {
    expect(shouldAdvanceDurableCursor(null, '12')).toBe(true);
    expect(shouldAdvanceDurableCursor(undefined, '12')).toBe(true);
    expect(shouldAdvanceDurableCursor('12', undefined)).toBe(false);
  });

  it('只向前推进数值游标', () => {
    expect(shouldAdvanceDurableCursor('2200', '2389')).toBe(true);
    expect(shouldAdvanceDurableCursor('2389', '2389')).toBe(false);
    expect(shouldAdvanceDurableCursor('2389', '2200')).toBe(false);
  });
});

describe('buildStreamStartedResume', () => {
  it('携带已保存 cursor 但 skipReplay，避免陈旧会话游标回放上一轮', () => {
    expect(buildStreamStartedResume('sid-1', '2200')).toEqual({
      action: 'resume',
      sessionId: 'sid-1',
      lastEventId: 0,
      lastEventCursor: '2200',
      skipReplay: true,
    });
  });
});

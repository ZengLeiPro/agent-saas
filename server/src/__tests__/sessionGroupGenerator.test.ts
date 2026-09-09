import { describe, expect, it } from 'vitest';
import { validateSessionGroupingSuggestion } from '../agent/sessionGroupGenerator.js';

describe('validateSessionGroupingSuggestion', () => {
  it('接受 fenced JSON，并把模型遗漏的会话保留为未分组', () => {
    const result = validateSessionGroupingSuggestion(
      '```json\n{"groups":[{"name":"销售","sessionIds":["s1"]}],"ungroupedSessionIds":[]}\n```',
      ['s1', 's2'],
    );
    expect(result).toEqual({
      groups: [{ name: '销售', sessionIds: ['s1'] }],
      ungroupedSessionIds: ['s2'],
    });
  });

  it('拒绝未知或重复会话', () => {
    expect(() =>
      validateSessionGroupingSuggestion(
        '{"groups":[{"name":"A","sessionIds":["other"]}],"ungroupedSessionIds":[]}',
        ['s1'],
      ),
    ).toThrow('未知会话');
    expect(() =>
      validateSessionGroupingSuggestion(
        '{"groups":[{"name":"A","sessionIds":["s1"]}],"ungroupedSessionIds":["s1"]}',
        ['s1'],
      ),
    ).toThrow('重复返回会话');
  });
});

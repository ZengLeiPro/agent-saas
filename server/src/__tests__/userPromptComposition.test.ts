import { describe, expect, it } from 'vitest';
import { appendUserPromptAddition } from '../agent/userPromptComposition.js';

describe('appendUserPromptAddition', () => {
  it('未配置个人偏好时保持平台提示语不变', () => {
    expect(appendUserPromptAddition('平台规则\n', '  ', 'title')).toBe('平台规则\n');
  });

  it('把标题偏好放在平台规则和衔接说明之后', () => {
    const result = appendUserPromptAddition('平台规则', '优先使用客户名称', 'title');
    expect(result.indexOf('平台规则')).toBeLessThan(result.indexOf('补充偏好'));
    expect(result.endsWith('优先使用客户名称')).toBe(true);
    expect(result).toContain('不违反上述长度、输出格式和安全要求');
  });

  it('智能分组偏好不能覆盖系统保护规则', () => {
    expect(appendUserPromptAddition('平台分组规则', '按客户分类', 'session-grouping')).toContain(
      '不能改变上述输出格式、会话归属范围和系统分组保护规则',
    );
  });
});

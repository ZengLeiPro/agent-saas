import { describe, expect, it } from 'vitest';
import { formatSubagentFailureHeader } from '../runtime/subagent/subagentFailureFormatting.js';
import type { SubagentOutcome } from '../runtime/subagent/subagentRunner.js';

function policyOutcome(): SubagentOutcome {
  return {
    status: 'failed',
    text: '已生成的部分结论',
    errorMessage: '当前模型受策略限制，请切换其他模型继续。',
    failureKind: 'policy_rejection',
    recoveryAction: 'switch_model',
    totalTokens: 10,
    toolUseCount: 0,
    turnCount: 1,
    durationMs: 500,
    childSessionId: 'sub-policy',
    childRunId: 'run-policy',
    model: 'group/model',
  };
}

describe('subagent policy failure', () => {
  it('返回可识别恢复结果且不泄露 provider 错误', () => {
    const header = formatSubagentFailureHeader(policyOutcome(), 'child=sub-policy');

    expect(header).toContain('[子 agent 策略拒绝]');
    expect(header).toContain('recovery=switch_model');
    expect(header).toContain('当前模型受策略限制，请切换其他模型继续。');
    expect(header).not.toContain('cyber_policy');
    expect(header).not.toContain('Responses API');
  });
});

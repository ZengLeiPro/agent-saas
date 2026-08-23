import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runtime/runStore.js';
import type { BackgroundTaskMetadata } from '../runtime/background/backgroundTaskMetadata.js';
import { buildTaskNotification } from '../runtime/background/backgroundTaskFormatting.js';

describe('background task policy failure', () => {
  it('通知保留结构化恢复动作且不泄露 provider 错误', () => {
    const task = {
      runId: 'bg-policy',
      status: 'failed',
      statusReason: 'Responses API HTTP 400: cyber_policy request_id=req-secret',
      metadata: {
        backgroundResult: {
          status: 'failed',
          text: '前一轮正文当前轮部分结论',
          errorMessage: 'Responses API HTTP 400: cyber_policy request_id=req-secret',
          failureKind: 'policy_rejection',
          recoveryAction: 'switch_model',
          totalTokens: 10,
          toolUseCount: 0,
          turnCount: 1,
          durationMs: 500,
        },
      },
    } as unknown as RunRecord;
    const metadata = {
      taskType: 'agent',
      parentToolCallId: 'tool-policy',
      description: '策略测试',
      shortTaskId: 'T-POLICY',
    } as unknown as BackgroundTaskMetadata;

    const content = buildTaskNotification(task, metadata);

    expect(content).toContain('<failure-kind>policy_rejection</failure-kind>');
    expect(content).toContain('<recovery-action>switch_model</recovery-action>');
    expect(content).toContain('当前模型受策略限制，请切换其他模型继续。');
    expect(content).toContain('前一轮正文');
    expect(content).toContain('当前轮部分结论');
    expect(content).not.toContain('cyber_policy');
    expect(content).not.toContain('Responses API');
    expect(content).not.toContain('req-secret');
  });
});

import { describe, expect, it } from 'vitest';
import type { CatalogScenarioPublic } from '@agent/shared';
import { workflowDiagnosisMessage, workflowTrialMessage } from './workflowLaunch';

function make(startMode: CatalogScenarioPublic['launch']['startMode']): CatalogScenarioPublic {
  return {
    id: 'catalog-a',
    title: '交付风险日报',
    launch: {
      sampleAvailable: true,
      startMode,
      entry: { kind: 'business_event', content: '客户在群里催单' },
      starterMessage: '帮我看看这单交付情况',
    },
  } as CatalogScenarioPublic;
}

describe('工作流起手消息', () => {
  it('chat 入口直接用服务端 starterMessage', () => {
    expect(workflowTrialMessage(make('chat'))).toBe('帮我看看这单交付情况');
  });

  it('非 chat 入口必须显式限定为示例数据，不得暗示生产执行', () => {
    const message = workflowTrialMessage(make('connector'));
    expect(message).toContain('请用示例数据带我体验「交付风险日报」。');
    expect(message).toContain('客户在群里催单');
    expect(message).toContain('不要连接或写入任何真实业务系统');
  });

  it('诊断话术要求先确认边界与人审', () => {
    expect(workflowDiagnosisMessage(make('diagnosis'))).toBe(
      '我想为「交付风险日报」预约落地诊断，请先确认业务边界、现有系统和所需人审。',
    );
  });
});

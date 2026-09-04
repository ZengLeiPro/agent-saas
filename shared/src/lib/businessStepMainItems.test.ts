import { describe, expect, it } from 'vitest';

import { businessStepMainItems } from './businessStepMainItems';
import type { RenderItem } from '../types/message';

const plan = (id: string, runId?: string) =>
  ({
    type: 'business_step',
    id,
    anchorMessageId: `anchor-${id}`,
    ...(runId ? { runId } : {}),
    kind: 'plan',
    todos: [],
  }) as RenderItem;

const start = {
  type: 'business_step',
  id: 'start-1',
  anchorMessageId: 'todo-1',
  kind: 'start',
} as Extract<RenderItem, { type: 'business_step' }>;

describe('businessStepMainItems 主区投影', () => {
  it('主区隐藏步骤过程，但保留真实人工门禁与排队中的用户插话', () => {
    const queuedUser = {
      id: 'queued-user',
      type: 'user',
      content: '补充一条',
      status: 'queued',
    } as RenderItem;
    const permission = {
      id: 'permission',
      type: 'permission_request',
      interactionId: 'interaction-1',
      toolName: 'Write',
      toolInput: '{}',
      status: 'pending',
    } as RenderItem;
    const processText = { id: 'process', type: 'text', content: '处理中' } as RenderItem;
    const outsideText = { id: 'outside', type: 'text', content: '最终回复' } as RenderItem;
    const section = {
      type: 'business_step_section',
      id: 'section-1',
      start,
      items: [processText, queuedUser, permission],
      isActive: true,
    } as RenderItem;

    expect(
      businessStepMainItems([plan('plan-1'), section, outsideText]).map((item) => item.id),
    ).toEqual(['plan-1', 'queued-user', 'permission', 'outside']);
  });

  it('同一个 Run 只留最新一张计划卡，不同 Run 各留一张', () => {
    const items = [
      plan('plan-a1', 'run-a'),
      plan('plan-a2', 'run-a'),
      plan('plan-b1', 'run-b'),
      plan('plan-a3', 'run-a'),
    ];
    expect(businessStepMainItems(items).map((item) => item.id)).toEqual(['plan-b1', 'plan-a3']);
  });

  it('缺 runId 时退到计划世代 / anchor 消息分组', () => {
    const generational = (id: string, generationId: string) =>
      ({
        type: 'business_step',
        id,
        anchorMessageId: `anchor-${id}`,
        generationId,
        kind: 'plan',
        todos: [],
      }) as RenderItem;
    const items = [generational('g1', 'gen-1'), generational('g2', 'gen-1'), plan('anchored')];
    expect(businessStepMainItems(items).map((item) => item.id)).toEqual(['g2', 'anchored']);
  });

  it('非计划的步骤事件不进主区', () => {
    expect(businessStepMainItems([start, plan('plan-1')]).map((item) => item.id)).toEqual([
      'plan-1',
    ]);
  });

  it('sections=keep 时步骤节原样保留，计划卡去重照旧', () => {
    const section = {
      type: 'business_step_section',
      id: 'section-1',
      start,
      items: [{ id: 'process', type: 'text', content: '处理中' } as RenderItem],
      isActive: true,
    } as RenderItem;
    const items = [plan('plan-a1', 'run-a'), section, plan('plan-a2', 'run-a')];
    expect(businessStepMainItems(items, { sections: 'keep' }).map((item) => item.id)).toEqual([
      'section-1',
      'plan-a2',
    ]);
  });
});

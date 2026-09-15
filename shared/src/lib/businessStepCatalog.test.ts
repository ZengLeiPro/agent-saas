import { describe, expect, it, vi, afterEach } from 'vitest';
import type { RenderItem } from '../types/message';
import {
  buildBusinessStepCatalog,
  businessStepTimingByPlanId,
  businessStepTimingByTodoKey,
  resolveBusinessStepDurationMs,
} from './businessStepCatalog';

afterEach(() => {
  vi.useRealTimers();
});

function planItem(): Extract<RenderItem, { type: 'business_step' }> {
  return {
    id: 'plan-1',
    type: 'business_step',
    kind: 'plan',
    anchorMessageId: 'anchor-1',
    todos: [
      { id: 'read', content: '读取材料', status: 'completed' },
      { id: 'verify', content: '核对结果', status: 'in_progress' },
    ],
  };
}

describe('buildBusinessStepCatalog timing', () => {
  it('从步骤节叶子汇总墙钟耗时，并暴露 live 起点', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    const items: RenderItem[] = [
      planItem(),
      {
        id: 'sec-read',
        type: 'business_step_section',
        isActive: false,
        start: {
          id: 'start-read',
          type: 'business_step',
          kind: 'start',
          anchorMessageId: 'anchor-1',
          todo: { id: 'read', content: '读取材料', status: 'in_progress' },
        },
        items: [
          {
            id: 'think-read',
            type: 'thinking',
            content: '读取中',
            startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
            durationMs: 12_400,
          },
        ],
      },
      {
        id: 'sec-verify',
        type: 'business_step_section',
        isActive: true,
        start: {
          id: 'start-verify',
          type: 'business_step',
          kind: 'start',
          anchorMessageId: 'anchor-1',
          todo: { id: 'verify', content: '核对结果', status: 'in_progress' },
        },
        items: [
          {
            id: 'think-1',
            type: 'thinking',
            content: '…',
            streaming: true,
            startedAt: Date.parse('2026-01-01T00:00:30.000Z'),
          },
        ],
      },
    ];

    const catalog = buildBusinessStepCatalog(items);
    const byKey = businessStepTimingByTodoKey(catalog.plans[0]);
    expect(byKey.get('id:read')?.durationMs).toBe(12_400);
    expect(byKey.get('id:read')?.liveStartedAtMs).toBeUndefined();
    expect(byKey.get('id:verify')?.liveStartedAtMs).toBe(Date.parse('2026-01-01T00:00:30.000Z'));
    expect(byKey.get('id:verify')?.durationMs).toBe(30_000);

    const byPlan = businessStepTimingByPlanId(catalog);
    expect(byPlan.get('plan-1')?.get('id:read')?.durationMs).toBe(12_400);
  });
});

describe('resolveBusinessStepDurationMs', () => {
  it('live 行按 measuredAt 外推；无 live 返回静态值；缺数据省略', () => {
    expect(resolveBusinessStepDurationMs(undefined, 1000)).toBeUndefined();
    expect(resolveBusinessStepDurationMs({ durationMs: 1200 }, 9999)).toBe(1200);
    expect(
      resolveBusinessStepDurationMs(
        { durationMs: 10_000, liveStartedAtMs: 1, timingMeasuredAtMs: 5_000 },
        8_000,
      ),
    ).toBe(13_000);
    expect(resolveBusinessStepDurationMs({ liveStartedAtMs: 1_000 }, 4_000)).toBe(3_000);
  });
});

import { describe, expect, it } from 'vitest';

import {
  activityLeafInterval,
  activityWallClockDurationMs,
  collectActivityTimingLeaves,
  earliestLiveStartedAtMs,
  mergeIntervalDurationMs,
  orphanDurationFallbackMs,
} from './wallClockDuration';

describe('mergeIntervalDurationMs', () => {
  it('空输入为 0', () => {
    expect(mergeIntervalDurationMs([])).toBe(0);
  });

  it('合并重叠区间取并集', () => {
    expect(
      mergeIntervalDurationMs([
        { startMs: 0, endMs: 1000 },
        { startMs: 500, endMs: 1500 },
      ]),
    ).toBe(1500);
  });

  it('串行区间相加', () => {
    expect(
      mergeIntervalDurationMs([
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2500 },
      ]),
    ).toBe(2500);
  });

  it('有缺口时只计覆盖长度', () => {
    expect(
      mergeIntervalDurationMs([
        { startMs: 0, endMs: 1000 },
        { startMs: 2000, endMs: 2500 },
      ]),
    ).toBe(1500);
  });

  it('忽略非法区间', () => {
    expect(
      mergeIntervalDurationMs([
        { startMs: 10, endMs: 5 },
        { startMs: Number.NaN, endMs: 20 },
        { startMs: 0, endMs: 100 },
      ]),
    ).toBe(100);
  });
});

describe('activityLeafInterval / activityWallClockDurationMs', () => {
  it('startedAt + durationMs 形成闭区间', () => {
    expect(
      activityLeafInterval({ type: 'thinking', startedAt: 1000, durationMs: 400 }, 9999),
    ).toEqual({ startMs: 1000, endMs: 1400 });
  });

  it('进行中 thinking 用 nowMs 封口', () => {
    expect(
      activityLeafInterval({ type: 'thinking', startedAt: 1000, streaming: true }, 1800),
    ).toEqual({ startMs: 1000, endMs: 1800 });
  });

  it('并行重叠叶子取并集而不是求和', () => {
    const ms = activityWallClockDurationMs(
      [
        { type: 'thinking', startedAt: 0, durationMs: 1000 },
        { type: 'tool_use', startedAt: 400, durationMs: 1000 },
      ],
      { nowMs: 10_000 },
    );
    expect(ms).toBe(1400);
  });

  it('串行叶子取并集等于总跨度', () => {
    const ms = activityWallClockDurationMs(
      [
        { type: 'thinking', startedAt: 0, durationMs: 500 },
        { type: 'tool_use', startedAt: 500, durationMs: 700 },
      ],
      { nowMs: 10_000 },
    );
    expect(ms).toBe(1200);
  });

  it('有缺口时不计空白', () => {
    const ms = activityWallClockDurationMs(
      [
        { type: 'thinking', startedAt: 0, durationMs: 300 },
        { type: 'tool_use', startedAt: 1000, durationMs: 200 },
      ],
      { nowMs: 10_000 },
    );
    expect(ms).toBe(500);
  });

  it('仅有 durationMs 时串行求和', () => {
    expect(
      activityWallClockDurationMs([
        { type: 'tool_use', durationMs: 400 },
        { type: 'tool_use', durationMs: 600 },
      ]),
    ).toBe(1000);
  });

  it('多个仅 durationMs 的 subagent 取 max（扇出并行启发）', () => {
    expect(
      orphanDurationFallbackMs([
        { type: 'subagent', durationMs: 800 },
        { type: 'subagent', durationMs: 1200 },
      ]),
    ).toBe(1200);
    expect(
      activityWallClockDurationMs([
        { type: 'subagent', durationMs: 800 },
        { type: 'subagent', durationMs: 1200 },
      ]),
    ).toBe(1200);
  });

  it('有日期区间时把无 start 的 durationMs 追加到并集', () => {
    expect(
      activityWallClockDurationMs(
        [
          { type: 'thinking', startedAt: 0, durationMs: 500 },
          { type: 'tool_use', durationMs: 300 },
        ],
        { nowMs: 10_000 },
      ),
    ).toBe(800);
  });

  it('无任何耗时数据返回 undefined', () => {
    expect(activityWallClockDurationMs([{ type: 'tool_use' }])).toBeUndefined();
    expect(activityWallClockDurationMs([])).toBeUndefined();
  });

  it('进行中步骤有 startedAt 时给出 live 起点', () => {
    expect(
      earliestLiveStartedAtMs([
        { type: 'thinking', startedAt: 50, streaming: true },
        { type: 'tool_use', durationMs: 10 },
      ]),
    ).toBe(50);
    expect(
      earliestLiveStartedAtMs([{ type: 'tool_use', durationMs: 10, executionStatus: 'running' }]),
    ).toBeUndefined();
  });
});

describe('collectActivityTimingLeaves', () => {
  it('展开 activity_group 与 business_step_section', () => {
    const leaves = collectActivityTimingLeaves([
      {
        type: 'business_step_section',
        id: 'sec',
        start: { type: 'business_step', id: 's', anchorMessageId: 'a', kind: 'start' },
        isActive: false,
        items: [
          {
            type: 'activity_group',
            id: 'g',
            isActive: false,
            items: [
              { id: 't1', type: 'thinking', content: 'x', durationMs: 100, startedAt: 1 },
              {
                id: 'u1',
                type: 'tool_use',
                toolName: 'Bash',
                toolInput: '',
                toolId: 'c1',
                durationMs: 200,
              },
            ],
          },
        ],
      },
    ]);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].type).toBe('thinking');
    expect(leaves[1].type).toBe('tool_use');
  });
});

/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const make =
    (tag: string) =>
    ({
      children,
      testID,
      accessibilityLabel,
      style,
      ...rest
    }: {
      children?: React.ReactNode;
      testID?: string;
      accessibilityLabel?: string;
      style?: unknown;
      [key: string]: unknown;
    }) =>
      ReactModule.createElement(
        tag,
        { 'data-testid': testID, 'aria-label': accessibilityLabel, style, ...rest },
        children,
      );
  return {
    View: make('div'),
    Text: make('span'),
    Pressable: make('button'),
    StyleSheet: {
      create: (s: Record<string, unknown>) => s,
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: React.ReactNode }) => children },
}));

vi.mock('lucide-react-native', () => ({
  Circle: () => null,
  CircleCheck: () => null,
  CircleX: () => null,
  Clock3: () => null,
  Loader2: () => null,
  TriangleAlert: () => null,
}));

vi.mock('../../../theme', () => ({
  useColors: () => ({
    foreground: '#111',
    mutedForeground: '#666',
    card: '#fff',
    border: '#ddd',
    accent: '#eef',
  }),
  useChatTypography: () => ({
    bodySmall: { fontSize: 14 },
    meta: { fontSize: 11 },
  }),
  spacing: { xs: 4, sm: 8, md: 12 },
  radius: { lg: 12, full: 999 },
  fontWeight: { medium: '500', semibold: '600' },
}));

vi.mock('../../ui', () => ({
  useSpinStyle: () => ({}),
}));

vi.mock('./tone', () => ({
  resolveActivityToneTokens: () => ({ tint: '#888', subtle: '#eee', ink: '#333' }),
}));

import { BusinessStepTimelineRow } from './BusinessStepTimeline';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BusinessStepTimelineRow duration', () => {
  it('无 timing 时不渲染耗时位', () => {
    render(
      <BusinessStepTimelineRow
        todo={{ id: 'a', content: '读取材料', status: 'completed' }}
        index={1}
        isFirst
        isLast
      />,
    );
    expect(screen.queryByTestId('business-step-duration')).toBeNull();
    expect(screen.getByText('01')).toBeTruthy();
  });

  it('静态耗时显示在序号前；a11y 含耗时', () => {
    render(
      <BusinessStepTimelineRow
        todo={{ id: 'a', content: '读取材料', status: 'completed' }}
        index={1}
        isFirst
        isLast
        timing={{ durationMs: 12_400 }}
        onPress={() => undefined}
      />,
    );
    const duration = screen.getByTestId('business-step-duration');
    expect(duration.textContent).toBe('12s');
    expect(screen.getByLabelText(/读取材料.*12s/)).toBeTruthy();
  });

  it('live 行按墙钟外推并随 tick 更新', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
    render(
      <BusinessStepTimelineRow
        todo={{ id: 'b', content: '核对结果', status: 'in_progress' }}
        index={2}
        isFirst={false}
        isLast
        timing={{
          durationMs: 5_000,
          liveStartedAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
          timingMeasuredAtMs: Date.parse('2026-01-01T00:00:05.000Z'),
        }}
      />,
    );
    // base 5s + (10s - 5s measured) = 10s
    expect(screen.getByTestId('business-step-duration').textContent).toBe('10s');
    // fake timers 下 advance 同时推进 Date.now；从 10s 再推 2s → 12s。
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('business-step-duration').textContent).toBe('12s');
  });
});

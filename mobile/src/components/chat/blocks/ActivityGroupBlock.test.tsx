/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityGroup, MessageItem } from '@agent/shared';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const make =
    (tag: string) =>
    ({
      children,
      testID,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      style,
    }: {
      children?: React.ReactNode;
      testID?: string;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { expanded?: boolean };
      style?: unknown;
    }) =>
      ReactModule.createElement(
        tag,
        {
          'data-testid': testID,
          'aria-label': accessibilityLabel,
          role: accessibilityRole === 'button' ? 'button' : undefined,
          'aria-expanded': accessibilityState?.expanded,
          style,
        },
        children,
      );
  return {
    View: make('div'),
    Text: make('span'),
    Pressable: make('button'),
    ActivityIndicator: () => ReactModule.createElement('span', { 'data-testid': 'spinner' }),
    StyleSheet: { create: (s: Record<string, unknown>) => s, hairlineWidth: 1 },
  };
});

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: React.ReactNode }) => children },
}));

vi.mock('lucide-react-native', () => ({
  CheckCircle2: () => null,
  ChevronRight: () => null,
  CircleAlert: () => null,
  CircleCheck: () => null,
  CircleX: () => null,
  Clock3: () => null,
  Loader2: () => null,
  PauseCircle: () => null,
}));

vi.mock('../../../theme', () => ({
  useColors: () => ({
    foreground: '#111',
    mutedForeground: '#666',
    primary: '#06f',
    success: '#0a0',
    warning: '#a80',
    destructive: '#c00',
    border: '#ddd',
    background: '#fff',
    muted: '#f5f5f5',
    successFamily: { DEFAULT: '#0a0', subtle: '#efe', ink: '#040' },
    warningFamily: { DEFAULT: '#a80', subtle: '#ffe', ink: '#640' },
    dangerFamily: { DEFAULT: '#c00', subtle: '#fee', ink: '#400' },
    infoFamily: { DEFAULT: '#06f', subtle: '#eef', ink: '#036' },
  }),
  useChatTypography: () => ({
    bodySmall: { fontSize: 14 },
    caption: { fontSize: 12 },
  }),
  spacing: { xs: 4, sm: 8, md: 12 },
  typography: { bodySmall: { fontSize: 14 }, caption: { fontSize: 12 } },
  fontScale: { xs2: { fontSize: 11 } },
}));

vi.mock('../../ui', () => ({
  useSpinStyle: () => ({}),
}));

vi.mock('./ThinkingBlock', () => ({ ThinkingBlock: () => null }));
vi.mock('./ToolBlock', () => ({ ToolUseBlock: () => null, ToolResultBlock: () => null }));
vi.mock('./SubagentBlock', () => ({ SubagentBlock: () => null }));
vi.mock('./SystemBlocks', () => ({ SystemTimelineMessage: () => null }));

import { ActivityGroupView, ExecutionHiddenPlaceholder } from './ActivityGroupBlock';

afterEach(() => cleanup());

const runningTool: Extract<MessageItem, { type: 'tool_use' }> = {
  id: 'tool-1',
  type: 'tool_use',
  toolName: 'Shell',
  toolInput: '{}',
  toolId: 'c1',
  executionStatus: 'running',
  streaming: true,
};

describe('ActivityGroupView running UI', () => {
  it('非 debug 折叠行不可展开，不显示「运行中」可视标签，meta 含项数', () => {
    const group: ActivityGroup = {
      id: 'g1',
      type: 'activity_group',
      items: [runningTool],
      isActive: true,
    };
    render(<ActivityGroupView group={group} gate={{ explicitSessionToggle: false }} />);
    expect(screen.queryByText('运行中')).toBeNull();
    expect(screen.getByText(/1 项/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('debug 可展开；完成态 meta 含耗时', () => {
    const done: Extract<MessageItem, { type: 'tool_use' }> = {
      ...runningTool,
      id: 'tool-done',
      executionStatus: 'completed',
      resultReady: true,
      result: 'ok',
      durationMs: 1200,
      streaming: false,
    };
    const group: ActivityGroup = {
      id: 'g2',
      type: 'activity_group',
      items: [done],
      isActive: false,
    };
    render(<ActivityGroupView group={group} gate={{ explicitSessionToggle: true }} />);
    expect(screen.getByRole('button')).toBeTruthy();
    expect(screen.getByText(/1\.2s · 1 项/)).toBeTruthy();
  });
});

describe('ExecutionHiddenPlaceholder', () => {
  it('活动中文案为「正在执行中」；完成后带耗时', () => {
    const { rerender } = render(<ExecutionHiddenPlaceholder isActive />);
    expect(screen.getByText('正在执行中')).toBeTruthy();
    rerender(<ExecutionHiddenPlaceholder durationMs={2500} />);
    expect(screen.getByText('已执行 2.5s')).toBeTruthy();
  });
});

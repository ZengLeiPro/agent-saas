// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const make =
    (tag: string) =>
    ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement(tag, { 'data-testid': testID }, children);
  return {
    View: make('div'),
    Text: make('span'),
    TouchableOpacity: make('button'),
    TextInput: make('input'),
  };
});
vi.mock('lucide-react-native', () => ({
  Circle: () => null,
  CircleDot: () => null,
  Square: () => null,
  SquareCheck: () => null,
}));
vi.mock('../../../theme', () => ({
  useColors: () => ({
    foreground: '#111',
    mutedForeground: '#666',
    primary: '#06f',
    secondary: '#eee',
  }),
  useChatTypography: () => ({ body: {}, caption: {} }),
  spacing: { xs: 4, sm: 8 },
}));
vi.mock('./shared', () => ({
  useMessageStyles: () => ({
    askUserBlock: {},
    questionContainer: {},
    questionHeader: {},
    optionButton: {},
    optionSelected: {},
    optionLabel: {},
    optionDesc: {},
    submitButton: {},
    submitText: {},
    statusBadge: {},
    allowedBadge: {},
  }),
}));

import { AskUserBlock } from './AskUserBlock';

afterEach(cleanup);

describe('AskUserBlock question context', () => {
  it('renders self-contained context below the question on mobile', () => {
    render(
      <AskUserBlock
        message={{
          id: 'ask-1',
          type: 'ask_user',
          interactionId: 'interaction-1',
          status: 'pending',
          questions: [
            {
              header: '确认写入',
              question: '是否将这些待修复项写入任务中心？',
              description: '已识别密码修改流程中的三项问题；确认后只创建任务，不会立即执行。',
              multiSelect: false,
              options: [
                { label: '确认写入', description: '创建任务但不派发执行' },
                { label: '取消', description: '不创建任务' },
              ],
            },
          ],
        }}
      />,
    );

    const question = screen.getByText('是否将这些待修复项写入任务中心？');
    const description = screen.getByText(
      '已识别密码修改流程中的三项问题；确认后只创建任务，不会立即执行。',
    );
    expect(
      question.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

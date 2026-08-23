import { createRef, type ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatTabContent } from './ChatTabContent';

vi.mock('@/components/AgentAvatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/components/OrgAgentAvatar', () => ({ OrgAgentAvatarContent: () => null }));
vi.mock('@/components/FileUpload', () => ({ FileUpload: () => null }));
vi.mock('@/components/AskUserPromptPanel', () => ({ AskUserPromptPanel: () => null }));
vi.mock('@/components/QueuedMessageBar', () => ({ QueuedMessageBar: () => null }));

vi.mock('@/components/MessageList', () => ({
  MessageList: ({ onSwitchModel }: { onSwitchModel?: () => void }) => (
    <button type="button" onClick={onSwitchModel}>切换模型</button>
  ),
}));

vi.mock('@/components/ChatInput', () => ({
  ChatInput: ({
    input,
    modelSelectorOpen,
    onModelChange,
  }: {
    input: string;
    modelSelectorOpen?: boolean;
    onModelChange?: (value: string) => void;
  }) => (
    <div>
      <div data-testid="composer-draft">{input}</div>
      <div data-testid="model-selector-state">{modelSelectorOpen ? 'open' : 'closed'}</div>
      <button type="button" onClick={() => onModelChange?.('other/model')}>选择其他模型</button>
    </div>
  ),
}));

type Props = ComponentProps<typeof ChatTabContent>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    messages: [{
      id: 'policy-error',
      type: 'system-error',
      content: '当前模型受策略限制，请切换其他模型继续。',
      severity: 'error',
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    }],
    loading: false,
    lastMessageRef: createRef<HTMLDivElement>(),
    scrollContainerRef: createRef<HTMLDivElement>(),
    uploadedFiles: [],
    onRemoveFile: vi.fn(),
    input: '尚未发送的草稿',
    uploading: false,
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onFileSelect: vi.fn(),
    modelList: {
      default: 'main/model',
      allowCrossGroupSwitch: true,
      showGroupNames: false,
      showContextTokens: false,
      allowContextTokenDetails: false,
      groups: [{ id: 'main', name: '主模型', models: [{ id: 'model', name: '当前模型' }] }],
    },
    selectedModel: 'main/model',
    sessionId: 'session-policy',
    onModelChange: vi.fn(),
    ...overrides,
  };
}

describe('ChatTabContent 策略拒绝恢复', () => {
  it('点击错误按钮打开现有模型选择器，保留会话草稿且不自动选模或发送', () => {
    const onModelChange = vi.fn();
    const onSend = vi.fn();
    render(<ChatTabContent {...makeProps({ onModelChange, onSend })} />);

    expect(screen.getByTestId('model-selector-state').textContent).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));

    expect(screen.getByTestId('model-selector-state').textContent).toBe('open');
    expect(screen.getByTestId('composer-draft').textContent).toBe('尚未发送的草稿');
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '选择其他模型' }));
    expect(onModelChange).toHaveBeenCalledWith('other/model');
    expect(screen.getByTestId('composer-draft').textContent).toBe('尚未发送的草稿');
    expect(onSend).not.toHaveBeenCalled();
  });
});

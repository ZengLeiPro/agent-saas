import { createRef, type ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatTabContent } from './ChatTabContent';

vi.mock('@/components/AgentAvatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/components/OrgAgentAvatar', () => ({ OrgAgentAvatarContent: () => null }));
vi.mock('@/components/FileUpload', () => ({ FileUpload: () => null }));
vi.mock('@/components/AskUserPromptPanel', () => ({ AskUserPromptPanel: () => null }));
vi.mock('@/components/QueuedMessageBar', () => ({ QueuedMessageBar: () => null }));

vi.mock('@/components/MessageList', () => ({
  MessageList: ({ messages, onSwitchModel }: { messages: Array<{ content?: string }>; onSwitchModel?: () => void }) => (
    <div>
      <div data-testid="session-history">{messages.map((message) => message.content).filter(Boolean).join('\n')}</div>
      <button type="button" onClick={onSwitchModel}>切换模型</button>
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
      groups: [{ id: 'main', name: '主模型', models: [{ id: 'model', name: '当前模型' }, { id: 'other', name: '其他模型' }] }],
    },
    selectedModel: 'main/model',
    sessionId: 'session-policy',
    onModelChange: vi.fn(),
    ...overrides,
  };
}

describe('ChatTabContent 策略拒绝恢复', () => {
  it('点击错误按钮操作真实模型选择器，换模后会话历史和草稿不丢且不自动发送', async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const onSend = vi.fn();
    render(<ChatTabContent {...makeProps({ onModelChange, onSend })} />);

    expect(screen.queryByRole('option', { name: '其他模型' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '切换模型' }));

    expect(await screen.findByRole('option', { name: '其他模型' })).toBeTruthy();
    expect(screen.getByDisplayValue('尚未发送的草稿')).toBeTruthy();
    expect(screen.getByTestId('session-history').textContent).toContain('当前模型受策略限制');
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    await user.click(screen.getByRole('option', { name: '其他模型' }));
    expect(onModelChange).toHaveBeenCalledWith('main/other');
    expect(screen.getByDisplayValue('尚未发送的草稿')).toBeTruthy();
    expect(screen.getByTestId('session-history').textContent).toContain('当前模型受策略限制');
    expect(onSend).not.toHaveBeenCalled();
  });
});

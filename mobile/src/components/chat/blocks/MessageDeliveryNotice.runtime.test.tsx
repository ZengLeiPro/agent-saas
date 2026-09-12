// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@agent/shared';

// Device/appearance/overlay boundaries only: UserMessage, UserVoiceBlock and the new delivery
// notice are imported and rendered for real. The adapter forwards accessibility and touch events.
vi.mock('react-native', async importOriginal => {
  const real = await importOriginal<typeof import('react-native')>();
  type NativeProps = { children?: React.ReactNode; accessibilityRole?: string; accessibilityLabel?: string;
    accessibilityHint?: string; accessibilityLiveRegion?: 'polite' | 'assertive' | 'off';
    onPress?: () => void; disabled?: boolean; testID?: string };
  const tag = (fallback: string) => (props: NativeProps) => {
    const role = props.accessibilityRole === 'text' ? undefined
      : props.accessibilityRole === 'summary' ? 'group' : props.accessibilityRole;
    const element = fallback === 'button' && role !== 'button' ? 'div' : fallback;
    return React.createElement(element, {
      role, 'aria-label': props.accessibilityLabel, 'aria-description': props.accessibilityHint,
      'aria-live': props.accessibilityLiveRegion, onClick: props.onPress, disabled: props.disabled,
      'data-testid': props.testID,
    }, props.children);
  };
  return { ...real, View: tag('div'), Text: tag('span'), Pressable: tag('button'), TouchableOpacity: tag('button'), Share: { share: vi.fn() } };
});
vi.mock('../../../theme', () => ({ useColors: () => ({}), useChatTypography: () => ({}), fontScale: { xs2: {} } }));
vi.mock('./shared', () => ({ useMessageStyles: () => ({}) }));
vi.mock('lucide-react-native', () => ({ Image: () => null, Mic: () => null, Paperclip: () => null,
  Pause: () => null, Play: () => null, Volume2: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../services/fileCacheService', () => ({ fileCacheService: { getOrDownloadAttachment: vi.fn(async () => 'safe-local-uri') } }));
vi.mock('../../overlays/DropdownMenu', () => ({ DropdownMenu: () => null }));
vi.mock('../ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../../../hooks/useVoicePlayer', () => ({ useVoicePlayer: () => ({ getState: () => 'idle', play: vi.fn(), togglePause: vi.fn() }) }));

import { UserMessage } from './UserMessage';
import { UserVoiceBlock } from './VoiceBlocks';
const text: Extract<MessageItem, { type: 'user' }> = {
  type: 'user', id: 'bubble-1', clientMsgId: 'original-id', content: 'original message', status: 'pending',
};
afterEach(cleanup);

describe('T66/T67: actual message components', () => {
  it('renders pending, then authoritative queued, then sent without a send-retry action', () => {
    const retry = vi.fn();
    const view = render(<UserMessage message={{ ...text, deliveryPhase: 'connecting' }} onRetry={retry} />);
    expect(screen.getByText('正在连接，等待发送…')).toBeTruthy();
    view.rerender(<UserMessage message={{ ...text, status: 'queued' }} onRetry={retry} />);
    expect(screen.getByText('已受理，正在排队')).toBeTruthy();
    expect(screen.queryByText(/正在连接|发送中/)).toBeNull();
    view.rerender(<UserMessage message={{ ...text, status: 'sent' }} onRetry={retry} />);
    expect(screen.getByText('original message')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重试|核验|编辑/ })).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
  it('unknown is non-spinning and its action retains typed metadata and original ID', () => {
    const message = { ...text, status: 'failed' as const, deliveryIssue: 'unknown' as const };
    const retry = vi.fn(); render(<UserMessage message={message} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('尚未确认是否送达');
    expect(screen.queryByText(/发送失败|发送中/)).toBeNull();
    const button = screen.getByRole('button', { name: '核验并重试' });
    expect(button.getAttribute('aria-description')).toContain('已受理时不会重复发送');
    fireEvent.click(button); expect(retry).toHaveBeenCalledExactlyOnceWith(message);
  });
  it('rejected is an edit action, not the unknown network retry action', () => {
    const message = { ...text, status: 'failed' as const, deliveryIssue: 'rejected' as const, failedReason: '服务端未受理此消息。' };
    const retry = vi.fn(); render(<UserMessage message={message} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toBe('服务端未受理此消息。');
    expect(screen.queryByRole('button', { name: '核验并重试' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新编辑' }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(message);
  });
  it('missing original payload offers read-only verification, and missing ID offers editing', () => {
    const retry = vi.fn();
    const message = { ...text, status: 'failed' as const, deliveryIssue: 'missing_payload' as const };
    const view = render(<UserMessage message={message} onRetry={retry} />);
    expect(screen.getByRole('button', { name: '核验状态' }).getAttribute('aria-description')).toContain('不重新发送');
    expect(screen.queryByRole('button', { name: '核验并重试' })).toBeNull();
    view.rerender(<UserMessage message={{ ...message, clientMsgId: undefined }} onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('缺少原消息标识');
    fireEvent.click(screen.getByRole('button', { name: '重新编辑' }));
    expect(retry.mock.calls[0][0].clientMsgId).toBeUndefined();
  });
  it('verification is a distinct bounded phase with no duplicate retry button', () => {
    render(<UserMessage message={{ ...text, deliveryPhase: 'verifying' }} onRetry={vi.fn()} />);
    expect(screen.getByText('正在核验发送状态…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /核验|重试/ })).toBeNull();
  });
  it('keeps image/file attachment IDs and display names through accepted projection', () => {
    const message = { ...text, status: 'queued' as const, attachments: [
      { attachmentId: 'image-original', name: 'diagram.png', isImage: true, mimeType: 'image/png', size: 100 },
      { attachmentId: 'file-original', name: 'report.pdf', isImage: false, mimeType: 'application/pdf', size: 200 },
    ] };
    const view = render(<UserMessage message={message} />);
    expect(screen.getByRole('button', { name: /查看图片：diagram.png/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /下载附件：report.pdf/ })).toBeTruthy();
    view.rerender(<UserMessage message={{ ...message, status: 'sent' }} />);
    expect(screen.getByText('diagram.png')).toBeTruthy(); expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(message.attachments.map(attachment => attachment.attachmentId)).toEqual(['image-original', 'file-original']);
  });
  it('voice delivery has the same unknown action and preserves its audio/transcription identities', () => {
    const message: Extract<MessageItem, { type: 'user-voice' }> = { type: 'user-voice', id: 'voice-bubble',
      audioUrl: '/api/attachments/audio-original/audio', clientMsgId: 'voice-original',
      attachmentId: 'audio-original', transcriptionId: 'transcription-original',
      duration: 3, transcribedText: 'spoken text', status: 'ready', deliveryPhase: 'awaiting_ack' };
    const retry = vi.fn(); const view = render(<UserVoiceBlock message={message} onRetry={retry} />);
    expect(screen.getByText('已写出，等待受理确认…')).toBeTruthy();
    const unknown = { ...message, status: 'failed' as const, deliveryPhase: undefined, deliveryIssue: 'unknown' as const };
    view.rerender(<UserVoiceBlock message={unknown} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: '核验并重试' }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(unknown);
    view.rerender(<UserVoiceBlock message={{ ...message, status: 'sent', deliveryPhase: undefined }} onRetry={retry} />);
    expect(screen.getByRole('button', { name: '播放语音，3 秒' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '核验并重试' })).toBeNull();
    expect(retry.mock.calls[0][0]).toMatchObject({ clientMsgId: 'voice-original', attachmentId: 'audio-original', transcriptionId: 'transcription-original' });
  });
});

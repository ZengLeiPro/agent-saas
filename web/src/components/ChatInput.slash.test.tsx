import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';

vi.mock('@/lib/sessionsApi', () => ({ warmupSessionSandbox: vi.fn() }));
vi.mock('@/hooks/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    isRecording: false, isSupported: false, duration: 0,
    ensurePermission: vi.fn(), startRecording: vi.fn(), stopAndSend: vi.fn(), cancelRecording: vi.fn(),
  }),
}));

function Harness({ onSend }: { onSend: () => void }) {
  const [input, setInput] = useState('');
  return <ChatInput input={input} uploading={false} hasUploadedFiles={false} onInputChange={setInput} onSend={onSend} onFileSelect={vi.fn()} />;
}

describe('ChatInput slash automation help', () => {
  it('shows registry help and completes a command before sending it', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const input = screen.getByRole('textbox', { name: '消息输入' });

    fireEvent.change(input, { target: { value: '/' } });
    expect(await screen.findByRole('listbox', { name: 'Slash 命令' })).toBeTruthy();
    expect(screen.getByText('/loop')).toBeTruthy();
    expect(screen.getByText('/goal')).toBeTruthy();

    fireEvent.change(input, { target: { value: '/go' } });
    await waitFor(() => expect(screen.queryByText('/loop')).toBeNull());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLTextAreaElement).value).toBe('/goal ');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledOnce();
  });
});

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useChatRightPanelController } from './useChatRightPanelController';

function callbacks() {
  return {
    openFilePreview: vi.fn(),
    closeFilePreview: vi.fn(),
    dockFilePreview: vi.fn(),
    expandFilePreview: vi.fn(),
    toggleFileBrowser: vi.fn(),
    closeFileBrowser: vi.fn(),
    closeSubagentTranscript: vi.fn(),
  };
}

interface ControllerStateProps {
  sessionId: string;
  previewFilePath: string | null;
  previewMode: 'dialog' | 'side';
  fileBrowserOpen: boolean;
  subagentTranscript: { childSessionId: string } | null;
  systemPanelOpen: boolean;
}

const baseProps: ControllerStateProps = {
  sessionId: 'session-1',
  previewFilePath: null,
  previewMode: 'dialog',
  fileBrowserOpen: false,
  subagentTranscript: null,
  systemPanelOpen: false,
};

describe('useChatRightPanelController', () => {
  it('dialog 预览保留步骤详情，side 预览才接管右栏并可恢复文件浏览器', () => {
    const fns = callbacks();
    const { result, rerender } = renderHook(
      (props: ControllerStateProps) => useChatRightPanelController({ ...props, ...fns }),
      { initialProps: baseProps },
    );

    act(() => result.current.handleBusinessStepPanelOpenChange(true));
    expect(result.current.rightPanelKind).toBe('business-step');

    act(() => result.current.handleOpenFilePreview('demo.md'));
    expect(fns.openFilePreview).toHaveBeenCalledWith('demo.md', undefined, undefined);
    expect(result.current.rightPanelKind).toBe('business-step');

    act(() => result.current.handleOpenFilePreview('demo.md', undefined, { mode: 'side' }));
    rerender({
      ...baseProps,
      previewFilePath: 'demo.md',
      previewMode: 'side',
      fileBrowserOpen: true,
    });
    expect(result.current.rightPanelKind).toBe('preview');

    act(() => result.current.handleExpandFilePreview());
    expect(fns.expandFilePreview).toHaveBeenCalledTimes(1);
    expect(fns.closeFileBrowser).not.toHaveBeenCalled();
    expect(result.current.rightPanelKind).toBe('browser');
  });

  it('文件浏览器被步骤详情隐藏时单击立即切回，不先关闭隐藏状态', () => {
    const fns = callbacks();
    const { result } = renderHook(
      (props: ControllerStateProps) => useChatRightPanelController({ ...props, ...fns }),
      { initialProps: { ...baseProps, fileBrowserOpen: true } },
    );

    expect(result.current.rightPanelKind).toBe('browser');
    act(() => result.current.handleBusinessStepPanelOpenChange(true));
    expect(result.current.rightPanelKind).toBe('business-step');
    expect(fns.closeFileBrowser).not.toHaveBeenCalled();

    act(() => result.current.handleToggleFileBrowser());
    expect(result.current.rightPanelKind).toBe('browser');
    expect(fns.closeFileBrowser).not.toHaveBeenCalled();
    expect(fns.toggleFileBrowser).not.toHaveBeenCalled();
  });

  it('当前可见的文件浏览器单击即关闭', () => {
    const fns = callbacks();
    const { result, rerender } = renderHook(
      (props: ControllerStateProps) => useChatRightPanelController({ ...props, ...fns }),
      { initialProps: { ...baseProps, fileBrowserOpen: true } },
    );

    expect(result.current.rightPanelKind).toBe('browser');
    act(() => result.current.handleToggleFileBrowser());
    expect(fns.closeFileBrowser).toHaveBeenCalledTimes(1);
    expect(fns.toggleFileBrowser).not.toHaveBeenCalled();
    rerender(baseProps);
    expect(result.current.rightPanelKind).toBeNull();
  });

  it('被自动 system 隐藏的文件浏览器也能单击接管', () => {
    const fns = callbacks();
    const { result } = renderHook(
      (props: ControllerStateProps) => useChatRightPanelController({ ...props, ...fns }),
      { initialProps: { ...baseProps, fileBrowserOpen: true, systemPanelOpen: true } },
    );

    expect(result.current.rightPanelKind).toBe('system');
    act(() => result.current.handleToggleFileBrowser());
    expect(result.current.rightPanelKind).toBe('browser');
    expect(fns.closeFileBrowser).not.toHaveBeenCalled();
    expect(fns.toggleFileBrowser).not.toHaveBeenCalled();
  });

  it('子 Agent 显式抢占自动 system，切会话时清理旧意图', () => {
    const fns = callbacks();
    const { result, rerender } = renderHook(
      (props: ControllerStateProps) => useChatRightPanelController({ ...props, ...fns }),
      { initialProps: { ...baseProps, systemPanelOpen: true } },
    );
    fns.closeSubagentTranscript.mockClear();

    rerender({
      ...baseProps,
      systemPanelOpen: true,
      subagentTranscript: { childSessionId: 'child-1' },
    });
    expect(result.current.rightPanelKind).toBe('subagent');

    rerender({ ...baseProps, sessionId: 'session-2', systemPanelOpen: true });
    expect(fns.closeSubagentTranscript).toHaveBeenCalled();
    expect(result.current.rightPanelKind).toBe('system');
  });
});

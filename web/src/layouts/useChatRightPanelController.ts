import { useCallback, useEffect, useState } from 'react';

import { resolveChatRightPanelKind, type ChatRightPanelIntent } from './chatRightPanelIntent';

type PreviewOptions = { mode?: 'dialog' | 'side' };

export function useChatRightPanelController({
  sessionId,
  previewFilePath,
  previewMode,
  previewArtifact,
  fileBrowserOpen,
  subagentTranscript,
  systemPanelOpen,
  openFilePreview,
  closeFilePreview,
  dockFilePreview,
  expandFilePreview,
  toggleFileBrowser,
  closeFileBrowser,
  closeSubagentTranscript,
}: {
  sessionId: string | null;
  previewFilePath: string | null;
  previewMode: 'dialog' | 'side';
  previewArtifact: { artifactId: string } | null;
  fileBrowserOpen: boolean;
  subagentTranscript: { childSessionId: string } | null;
  systemPanelOpen: boolean;
  openFilePreview: (path: string, owner?: string, options?: PreviewOptions) => void;
  closeFilePreview: () => void;
  dockFilePreview: () => void;
  expandFilePreview: () => void;
  toggleFileBrowser: () => void;
  closeFileBrowser: () => void;
  closeSubagentTranscript?: () => void;
}) {
  const sidePreviewOpen = !!previewFilePath && previewMode === 'side';
  const [businessStepPanelOpen, setBusinessStepPanelOpen] = useState(false);
  const [businessStepDetailHost, setBusinessStepDetailHost] = useState<HTMLDivElement | null>(null);
  const [intent, setIntent] = useState<ChatRightPanelIntent>(null);
  const rightPanelKind = resolveChatRightPanelKind(intent, {
    businessStep: businessStepPanelOpen,
    subagent: !!subagentTranscript,
    artifact: !!previewArtifact,
    preview: sidePreviewOpen,
    system: systemPanelOpen,
    browser: fileBrowserOpen,
  });

  const handleBusinessStepPanelOpenChange = useCallback((open: boolean) => {
    setBusinessStepPanelOpen(open);
    setIntent((current) => (open ? 'business-step' : current === 'business-step' ? null : current));
  }, []);

  const handleOpenFilePreview = useCallback(
    (path: string, owner?: string, options?: PreviewOptions) => {
      // Dialog 预览覆盖在当前页面上；只有 side 模式占用右栏 slot。
      if (options?.mode === 'side') {
        setBusinessStepPanelOpen(false);
        setIntent('preview');
      }
      openFilePreview(path, owner, options);
    },
    [openFilePreview],
  );

  const handleCloseFilePreview = useCallback(() => {
    closeFilePreview();
    setIntent((current) =>
      current === 'preview' ? (fileBrowserOpen ? 'browser' : null) : current,
    );
  }, [closeFilePreview, fileBrowserOpen]);

  const handleDockFilePreview = useCallback(() => {
    setBusinessStepPanelOpen(false);
    setIntent('preview');
    dockFilePreview();
  }, [dockFilePreview]);

  const handleExpandFilePreview = useCallback(() => {
    setIntent((current) =>
      current === 'preview' ? (fileBrowserOpen ? 'browser' : null) : current,
    );
    expandFilePreview();
  }, [expandFilePreview, fileBrowserOpen]);

  const handleToggleFileBrowser = useCallback(() => {
    if (rightPanelKind === 'browser') {
      closeFileBrowser();
      setIntent((current) => (current === 'browser' ? null : current));
      return;
    }
    // browser 可能仍是 open，只是被最近一次显式选择隐藏；此时按钮应单击接管，
    // 不能先关闭隐藏状态、再要求用户点第二次。
    setBusinessStepPanelOpen(false);
    setIntent('browser');
    if (!fileBrowserOpen) toggleFileBrowser();
  }, [closeFileBrowser, fileBrowserOpen, rightPanelKind, toggleFileBrowser]);

  const handleCloseFileBrowser = useCallback(() => {
    closeFileBrowser();
    setIntent((current) => (current === 'browser' ? null : current));
  }, [closeFileBrowser]);

  const handleCloseSubagentTranscript = useCallback(() => {
    closeSubagentTranscript?.();
    setIntent((current) => (current === 'subagent' ? null : current));
  }, [closeSubagentTranscript]);

  useEffect(() => {
    closeSubagentTranscript?.();
    setBusinessStepPanelOpen(false);
    setIntent(null);
  }, [closeSubagentTranscript, sessionId]);

  useEffect(() => {
    if (subagentTranscript) {
      setBusinessStepPanelOpen(false);
      setIntent('subagent');
      return;
    }
    setIntent((current) => (current === 'subagent' ? null : current));
  }, [subagentTranscript?.childSessionId]);

  useEffect(() => {
    if (previewArtifact) {
      setBusinessStepPanelOpen(false);
      setIntent('artifact');
      return;
    }
    setIntent((current) => (current === 'artifact' ? null : current));
  }, [previewArtifact?.artifactId]);

  useEffect(() => {
    if (sidePreviewOpen) {
      setBusinessStepPanelOpen(false);
      setIntent('preview');
      return;
    }
    setIntent((current) => (current === 'preview' ? null : current));
  }, [previewFilePath, sidePreviewOpen]);

  const rightPanelKey =
    rightPanelKind === 'business-step'
      ? 'business-step'
      : rightPanelKind === 'subagent'
        ? (subagentTranscript?.childSessionId ?? null)
        : rightPanelKind === 'artifact'
          ? (previewArtifact?.artifactId ?? null)
          : rightPanelKind === 'preview'
            ? previewFilePath
            : rightPanelKind;

  return {
    businessStepPanelOpen,
    businessStepDetailHost,
    setBusinessStepDetailHost,
    rightPanelKind,
    rightPanelKey,
    handleBusinessStepPanelOpenChange,
    handleOpenFilePreview,
    handleCloseFilePreview,
    handleDockFilePreview,
    handleExpandFilePreview,
    handleToggleFileBrowser,
    handleCloseFileBrowser,
    handleCloseSubagentTranscript,
  };
}

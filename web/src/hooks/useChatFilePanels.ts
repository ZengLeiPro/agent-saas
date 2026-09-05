import { useCallback, useState } from 'react';

/** 文件预览（弹窗 / 右侧面板）与文件管理器开关（从 useChatAppState 按域拆出，逻辑原样）。 */
export function useChatFilePanels() {
  // ---- File preview ----
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [explicitPreviewOwner, setExplicitPreviewOwner] = useState<string | undefined>(undefined);
  const [previewMode, setPreviewMode] = useState<'dialog' | 'side'>('dialog');
  const openFilePreview = useCallback(
    (path: string, owner?: string, options?: { mode?: 'dialog' | 'side' }) => {
      setPreviewFilePath(path);
      setExplicitPreviewOwner(owner);
      // md/PDF 附件卡默认走 "side"（右侧面板），让用户可以边预览边继续对话；
      // FileBrowser、代码块内联路径等调用点保持默认 "dialog" 弹窗行为。
      setPreviewMode(options?.mode ?? 'dialog');
    },
    [],
  );
  const dockFilePreview = useCallback(() => {
    setPreviewMode('side');
  }, []);
  const expandFilePreview = useCallback(() => {
    setPreviewMode('dialog');
  }, []);
  const closeFilePreview = useCallback(() => {
    setPreviewFilePath(null);
    setExplicitPreviewOwner(undefined);
    setPreviewMode('dialog');
  }, []);
  // ---- File browser ----
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const toggleFileBrowser = useCallback(() => setFileBrowserOpen((v) => !v), []);
  const closeFileBrowser = useCallback(() => setFileBrowserOpen(false), []);

  return {
    previewFilePath,
    setPreviewFilePath,
    explicitPreviewOwner,
    previewMode,
    openFilePreview,
    dockFilePreview,
    expandFilePreview,
    closeFilePreview,
    fileBrowserOpen,
    toggleFileBrowser,
    closeFileBrowser,
  };
}

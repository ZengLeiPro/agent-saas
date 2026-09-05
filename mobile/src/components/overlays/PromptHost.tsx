import React, { useCallback, useEffect, useState } from 'react';
import { registerPromptHandler, type TextPromptOptions } from '../../lib/prompt';
import { TextPrompt } from '../ui/TextPrompt';
import { ActionSheetHost } from '../ui/ActionSheet';

/**
 * 全局浮层宿主（`app/_layout.tsx` 挂载一次）。
 *
 * 承载两类命令式调用：
 *   - `showTextPrompt(...)`：Android 走这里的受控对话框（iOS 用原生 Alert.prompt）；
 *   - `showActionMenu(...)`：由 ActionSheetHost 渲染为底部动作面板。
 * 外观分别由 `components/ui/TextPrompt` 与 `components/ui/ActionSheet` 提供，
 * 本文件只负责「注册 handler + 生命周期」。
 */
export function PromptHost() {
  const [opts, setOpts] = useState<TextPromptOptions | null>(null);

  useEffect(() => {
    registerPromptHandler(setOpts);
    return () => registerPromptHandler(null);
  }, []);

  const handleCancel = useCallback(() => {
    const current = opts;
    setOpts(null);
    current?.onCancel?.();
  }, [opts]);

  const handleConfirm = useCallback(
    (value: string) => {
      const current = opts;
      setOpts(null);
      current?.onConfirm(value);
    },
    [opts],
  );

  const handleExtraAction = useCallback(() => {
    const action = opts?.extraAction;
    setOpts(null);
    action?.onPress();
  }, [opts]);

  return (
    <>
      {opts ? (
        <TextPrompt
          {...opts}
          visible
          extraAction={
            opts.extraAction
              ? { label: opts.extraAction.label, onPress: handleExtraAction }
              : undefined
          }
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : null}
      <ActionSheetHost />
    </>
  );
}

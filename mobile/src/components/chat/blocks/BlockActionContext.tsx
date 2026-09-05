/**
 * 呈现块动作的回写通道。
 *
 * 与 Web `MessageItemWithDisplay.tsx` 的 ctx 语义一致：
 * 动作按钮只有拿到 `interactionId` **且**上层给了 interaction 回写函数时才可点；
 * 缺任意一半就渲染成 disabled，不允许出现「点了没反应」的按钮。
 *
 * 移动端用 React context 而不是逐层 props：`CanonicalPresentationBody` 被工具块、
 * 业务步骤块、活动分组等多处复用，逐层透传等于把同一个回调抄七八遍。
 */
import React, { createContext, useContext, useMemo } from 'react';
import type { BlockContext } from './PresentationBlockViews';

const READ_ONLY: BlockContext = { readOnly: true };

const BlockActionCtx = createContext<BlockContext>(READ_ONLY);

/** 未挂 Provider 时默认只读——安全边界不靠调用方记得传参。 */
export function useBlockActionContext(): BlockContext {
  return useContext(BlockActionCtx);
}

export function BlockActionProvider({
  onPermissionResponse,
  children,
}: {
  /** 与 Web 同构：动作 label 为「拒绝」时回写 allow=false，其余回写 allow=true。 */
  onPermissionResponse?: (interactionId: string, allow: boolean) => Promise<void>;
  children: React.ReactNode;
}) {
  const value = useMemo<BlockContext>(
    () =>
      onPermissionResponse
        ? {
            readOnly: false,
            onAction: ({ interactionId, label }) => {
              void onPermissionResponse(interactionId, label !== '拒绝');
            },
          }
        : READ_ONLY,
    [onPermissionResponse],
  );

  return <BlockActionCtx.Provider value={value}>{children}</BlockActionCtx.Provider>;
}

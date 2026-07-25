import { useCallback, useMemo, useState } from "react";
import { foldPanel, type MessageItem, type PanelPatch, type SystemPanelSnapshot } from "@agent/shared";

/**
 * 从消息流里 fold 出右侧企业系统面板的当前快照。
 *
 * 真实会话与演示回放走**同一个** hook：面板数据挂在 ToolPresentation.panel /
 * panelBase 上，没有独立通道。演示能表达的面板 = 真实工具能产出的面板。
 *
 * 后退一律从 base 重新 fold（patch 刻意不提供逆运算），这与消息数组的累加
 * 天然同构——回放退一步只是少喂几条 patch，不需要任何 reset 代码。
 */
export function useSystemPanel(messages: MessageItem[]): {
  snapshot: SystemPanelSnapshot | null;
  /** 用户手动切 tab；切过之后不再被后续 focus patch 抢走焦点 */
  selectView: (key: string) => void;
} {
  const [viewOverride, setViewOverride] = useState<string | null>(null);

  const folded = useMemo(() => {
    let base: SystemPanelSnapshot | null = null;
    const patches: PanelPatch[] = [];
    for (const message of messages) {
      if (message.type !== "tool_use" && message.type !== "tool_result") continue;
      const presentation = message.presentation;
      if (!presentation) continue;
      if (!base && presentation.panelBase) base = presentation.panelBase;
      if (presentation.panel?.length) patches.push(...presentation.panel);
    }
    return base ? foldPanel(base, patches) : null;
  }, [messages]);

  const snapshot = useMemo(() => {
    if (!folded) return null;
    if (!viewOverride || !folded.views.some((view) => view.key === viewOverride)) return folded;
    return { ...folded, activeView: viewOverride };
  }, [folded, viewOverride]);

  const selectView = useCallback((key: string) => setViewOverride(key), []);

  return { snapshot, selectView };
}

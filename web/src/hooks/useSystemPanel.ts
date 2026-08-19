import { useCallback, useEffect, useMemo, useState } from "react";
import { type MessageItem, type PanelPulse, type SystemPanelSnapshot } from "@agent/shared";
import { foldSystemPanelMessages } from "./systemPanelMessages";

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
  /** 最新一组面板 patch 声明的本步变化；下一组没有 pulse 时立即清空。 */
  pulse: PanelPulse | null;
  /** 用户手动切 tab；切过之后不再被后续 focus patch 抢走焦点 */
  selectView: (key: string) => void;
} {
  const [viewOverride, setViewOverride] = useState<string | null>(null);

  const folded = useMemo(() => foldSystemPanelMessages(messages), [messages]);

  const snapshot = useMemo(() => {
    if (!folded.snapshot) return null;
    if (!viewOverride || !folded.snapshot.views.some((view) => view.key === viewOverride)) return folded.snapshot;
    return { ...folded.snapshot, activeView: viewOverride };
  }, [folded.snapshot, viewOverride]);

  const selectView = useCallback((key: string) => setViewOverride(key), []);

  return { snapshot, pulse: folded.pulse, selectView };
}

const DISMISS_KEY_PREFIX = "system-panel-dismissed:";

/**
 * 真实会话里的面板停靠状态。
 *
 * 首次收到带 panel 的摘要时自动打开；**用户手动关闭一次后，本会话内不再
 * 自动打开**——面板是跟随 Agent 的自动行为，用户的显式意图必须能压过它，
 * 否则每次 Agent 动一下面板就弹回来，是骚扰。
 *
 * 按 sessionId 隔离：切会话即按该会话自己的消息流重新 fold。
 */
export function useSystemPanelDock(messages: MessageItem[], sessionId?: string | null): {
  snapshot: SystemPanelSnapshot | null;
  pulse: PanelPulse | null;
  open: boolean;
  selectView: (key: string) => void;
  dismiss: () => void;
} {
  const { snapshot, pulse, selectView } = useSystemPanel(messages);
  const [dismissed, setDismissed] = useState(false);

  // 切会话时重读该会话的关闭态；sessionStorage 让刷新后仍记得用户关过
  useEffect(() => {
    if (!sessionId) {
      setDismissed(false);
      return;
    }
    try {
      setDismissed(sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${sessionId}`) === "1");
    } catch {
      setDismissed(false);
    }
  }, [sessionId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (!sessionId) return;
    try {
      sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${sessionId}`, "1");
    } catch {
      // 隐私模式下 sessionStorage 可能不可写，关闭仍在本次渲染内生效
    }
  }, [sessionId]);

  return { snapshot, pulse, open: !!snapshot && !dismissed, selectView, dismiss };
}

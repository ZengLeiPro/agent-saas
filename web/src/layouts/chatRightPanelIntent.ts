export type ChatRightPanelIntent = 'business-step' | 'subagent' | 'preview' | 'browser' | null;
export type ChatRightPanelKind = Exclude<ChatRightPanelIntent, null> | 'system' | null;

export interface ChatRightPanelAvailability {
  businessStep: boolean;
  subagent: boolean;
  preview: boolean;
  system: boolean;
  browser: boolean;
}

/** 最近一次显式选择优先；system 只作为自动兜底，不得覆盖用户正在查看的详情。 */
export function resolveChatRightPanelKind(
  intent: ChatRightPanelIntent,
  available: ChatRightPanelAvailability,
): ChatRightPanelKind {
  if (intent === 'business-step' && available.businessStep) return 'business-step';
  if (intent === 'subagent' && available.subagent) return 'subagent';
  if (intent === 'preview' && available.preview) return 'preview';
  if (intent === 'browser' && available.browser) return 'browser';

  if (available.subagent) return 'subagent';
  if (available.preview) return 'preview';
  if (available.system) return 'system';
  if (available.browser) return 'browser';
  return null;
}

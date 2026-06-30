export type DingtalkConversationType = "1" | "2" | string;

export interface DingtalkSessionInfo {
  agentSessionId: string;
  sessionWebhook?: string;
  senderNick: string;
  senderId: string;
  conversationType: DingtalkConversationType;
  lastUpdated: number;
  lastUpdatedAt: string;
  createdAt: string;
  messageCount: number;
  modelRef?: string;
}

export interface DingtalkSessionStore {
  [conversationId: string]: DingtalkSessionInfo;
}

export interface SaveSessionOptions {
  conversationId: string;
  agentSessionId: string;
  sessionWebhook?: string;
  senderNick: string;
  senderId: string;
  conversationType: string;
}

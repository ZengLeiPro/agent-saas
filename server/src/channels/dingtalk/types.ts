export type {
  DingtalkConversationType,
  DingtalkSessionInfo,
  DingtalkSessionStore,
  SaveSessionOptions,
} from '../../data/sessions/types.js';

export interface DingtalkMessageContext {
  conversationId: string;
  content: string;
  sessionWebhook: string;
  senderNick?: string;
  senderId?: string;
  conversationType?: string;
  msgtype?: string;
  downloadCode?: string;
  fileName?: string;
  fileType?: string;
  /** 内部字段：缓冲合并后累积的额外媒体上下文 */
  _bufferedMedia?: DingtalkMessageContext[];
}

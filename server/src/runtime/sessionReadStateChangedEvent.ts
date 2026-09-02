export type SessionReadStateChangedEvent = {
  id: string;
  timestamp: string;
  type: 'session_read_state_changed';
  sessionId: string;
  userId: string;
  hasUnreadAiReply: boolean;
  readSeq?: number;
  serverVersion?: number;
  updatedAt?: string;
  sourceSeq?: number;
};

import type { TtsConfig } from '../../../types/index.js';

export type DingtalkMsgType = "text" | "markdown";

export interface SendDingtalkOptions {
  sessionWebhook: string;
  content: string;
  msgType: DingtalkMsgType;
  senderNick?: string;
  conversationType?: string;
  ttsConfig?: TtsConfig;
  credentials?: { appKey: string; appSecret: string };
}

import type { ChannelContext, InboundMessage, DingtalkRobotConfig } from '../../../types/index.js';
import type { DingtalkMessageContext } from '../types.js';
import type {
  AICardInstance,
  DingtalkCredentials,
  DingtalkMessageHelpers,
} from '../services/index.js';
import type { MediaTarget } from './mediaPostprocess.js';

export interface PreparedDingtalkMessage {
  inbound: InboundMessage;
  context: ChannelContext;
  source: DingtalkMessageContext;
  robotId?: string;
  robotConfig?: DingtalkRobotConfig;
  robotCredentials?: DingtalkCredentials;
  mediaTarget: MediaTarget;
  messageHelpers: DingtalkMessageHelpers;
  card: AICardInstance | null;
}

export interface DingtalkConsumeSummary {
  sessionId?: string;
  finalText: string;
  aiCardAccumulated: string;
  hasSentText: boolean;
}

export interface DingtalkPostprocessInput {
  prepared: PreparedDingtalkMessage;
  consumed: DingtalkConsumeSummary;
}

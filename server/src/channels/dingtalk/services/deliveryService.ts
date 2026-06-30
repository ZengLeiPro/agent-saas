import {
  sendDingtalkMessage,
  createMessageHelpers,
  type SendStatusFn,
  type SendMessageFn,
} from './sessionWebhookSender.js';
import type { DingtalkMessageContext } from '../types.js';
import type { SendDingtalkOptions } from './types.js';

export interface DingtalkMessageHelpers {
  sendStatus: SendStatusFn;
  sendMessage: SendMessageFn;
}

export interface DingtalkDeliveryService {
  createMessageHelpers(
    ctx: Pick<DingtalkMessageContext, 'sessionWebhook' | 'senderNick' | 'conversationType'>,
  ): DingtalkMessageHelpers;
  sendMessage(options: SendDingtalkOptions): Promise<void>;
}

export function createDingtalkDeliveryService(): DingtalkDeliveryService {
  return {
    createMessageHelpers(
      ctx: Pick<DingtalkMessageContext, 'sessionWebhook' | 'senderNick' | 'conversationType'>,
    ): DingtalkMessageHelpers {
      return createMessageHelpers(ctx.sessionWebhook, ctx.senderNick, ctx.conversationType);
    },

    async sendMessage(options: SendDingtalkOptions): Promise<void> {
      await sendDingtalkMessage(options);
    },
  };
}

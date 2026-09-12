import type { ChannelType } from '../../types/index.js';
import type { RunStore } from '../runStore.js';
import type { QueuedInterjection, RunContext } from '../types.js';
import { isWakeMessage } from '../wakeDispatchHelpers.js';

export function buildSubagentInterjectionLoader(
  runStore: RunStore | undefined,
  childRunId: string,
  childSessionId: string,
): Pick<RunContext, 'loadQueuedInterjections'> | Record<string, never> {
  if (!runStore?.listPendingSteeringInputs) return {};
  return {
    loadQueuedInterjections: async () => {
      const queued = await runStore.listPendingSteeringInputs!(childRunId);
      return queued.map((input): QueuedInterjection => {
        const wakeMessage = input.sourceRun.metadata?.wakeMessage;
        if (!isWakeMessage(wakeMessage)) {
          throw new Error(`子 Agent 插话 ${input.sourceRunId} 缺少 durable wakeMessage。`);
        }
        return {
          inputId: input.inputId,
          sourceRunId: input.sourceRunId,
          ...(typeof wakeMessage.metadata?.clientMsgId === 'string'
            ? { clientMsgId: wakeMessage.metadata.clientMsgId }
            : {}),
          message: {
            channel: (wakeMessage.channel ?? 'web') as ChannelType,
            chatId: wakeMessage.chatId ?? childSessionId,
            content: wakeMessage.content,
            senderId: wakeMessage.senderId,
            senderName: wakeMessage.senderName,
            metadata: wakeMessage.metadata,
          },
          prompt: wakeMessage.content,
        };
      });
    },
  };
}

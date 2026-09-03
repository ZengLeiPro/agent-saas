import type { ChannelContext } from '../../types/index.js';
import type { RunRecord } from '../runStore.js';
import type { BackgroundAgentRequest } from './backgroundTaskRuntime.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';

export function isBackgroundAgentIdempotentReplay(
  task: RunRecord | null,
  input: {
    parentRunId: string;
    parentSessionId: string;
    toolCallId: string;
    taskSessionId: string;
    tenantId?: string;
    model: string;
    request: BackgroundAgentRequest;
    orgChannel?: NonNullable<ChannelContext['orgAgentChannel']>;
  },
): boolean {
  if (!task) return false;
  const metadata = parseBackgroundTaskMetadata(task);
  return (
    metadata?.taskType === 'agent' &&
    metadata.parentRunId === input.parentRunId &&
    metadata.parentSessionId === input.parentSessionId &&
    metadata.parentToolCallId === input.toolCallId &&
    metadata.description === input.request.description &&
    metadata.prompt === input.request.prompt &&
    metadata.agentType === input.request.agentType &&
    task.sessionId === input.taskSessionId &&
    task.tenantId === input.tenantId &&
    task.model === input.model &&
    Boolean(metadata.orgAgentChannel) === Boolean(input.orgChannel) &&
    (!input.orgChannel ||
      (metadata.orgAgentChannel?.agentId === input.orgChannel.agentId &&
        metadata.orgAgentChannel.bindingId === input.orgChannel.bindingId &&
        metadata.orgAgentChannel.workConversationId === input.orgChannel.workConversationId))
  );
}

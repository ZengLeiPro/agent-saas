import type { ActivityMessageProjectionEvent } from '../activityMessageProjection';

/** Captured-shape fixture: deliberately includes replay, out-of-order and misleading domain strings. */
export const runtimeProjectionFixture: ActivityMessageProjectionEvent[] = [
  { eventId: 'text-start', domain: 'message', kind: 'assistant_block_start', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'text-1', blockType: 'text' },
  { eventId: 'text-delta', domain: 'message', kind: 'assistant_block_delta', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'text-1', blockType: 'text', delta: 'assistant says blocked denied policy' },
  { eventId: 'text-delta', domain: 'message', kind: 'assistant_block_delta', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'text-1', blockType: 'text', delta: 'assistant says blocked denied policy' },
  { eventId: 'tool-terminal', domain: 'tool', kind: 'tool_activity', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'tool-1', toolCallId: 'same-tool', toolName: 'Shell', status: 'failed', result: 'permission denied; workflow failed; blocked by remote API', resultReady: true },
  { eventId: 'tool-old-running', domain: 'tool', kind: 'tool_activity', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'tool-1', toolCallId: 'same-tool', toolName: 'Shell', status: 'running' },
  { eventId: 'sub-terminal', domain: 'subagent', kind: 'subagent_activity', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'sub-1', toolCallId: 'agent-call', subagentId: 'child-run', agentType: 'general', status: 'failed', errorMessage: 'workflow failed' },
  { eventId: 'sub-old-running', domain: 'subagent', kind: 'subagent_activity', runId: 'run-fixture', messageId: 'assistant:run-fixture', blockId: 'sub-1', toolCallId: 'agent-call', subagentId: 'child-run', agentType: 'general', status: 'running' },
  { eventId: 'true-moderation', domain: 'moderation', kind: 'moderation_outcome', runId: 'run-fixture', moderationId: 'guardrail-1', messageId: 'assistant:run-fixture', blockId: 'text-1', outcome: 'blocked', reasonCode: 'off_topic' },
];

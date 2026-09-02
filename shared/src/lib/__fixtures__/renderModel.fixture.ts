import type { MessageItem } from '../../types/message';
import type { RuntimeTimelineProjectionItem } from '../renderModel';

/** Captured canonical shapes from durable hydrate + live runtime projection. */
export const canonicalTimelineFixture: MessageItem[] = [
  { id: 'user-1', type: 'user', content: 'Run it', status: 'sent', timestamp: 100 },
  { id: 'text-1', type: 'text', runId: 'run-1', content: 'Working', streaming: true, timestamp: 110 },
  { id: 'tool-block', type: 'tool_use', runId: 'run-1', toolId: 'tool-1', toolName: 'Shell', toolInput: 'echo ok', executionStatus: 'running' },
  { id: 'sub-block', type: 'subagent', toolId: 'sub-tool', childRunId: 'child-1', agentType: 'general', status: 'running' },
  { id: 'file-1', type: 'file_download', fileName: 'report.pdf', fileType: 'application/pdf', filePath: 'assets/report.pdf', fileSize: 42 },
];

export const runtimeTimelineFixture: RuntimeTimelineProjectionItem[] = [
  { id: 'run-2-status', type: 'status', runId: 'run-2', status: 'waiting', content: 'Waiting for network', timestamp: 200 },
  { id: 'run-3-error', type: 'error', runId: 'run-3', status: 'failed', content: 'Request failed', domain: 'transport', retryability: 'retryable', timestamp: 210 },
];

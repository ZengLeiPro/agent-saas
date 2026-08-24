import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { FileEventStore } from '../runtime/fileEventStore.js';

export async function seedCompleteParallelToolUnit(eventStore: FileEventStore, sessionId: string) {
  return eventStore.appendBatch([
    { type: 'user_message', runId: 'run-history', sessionId, content: '检查状态' },
    { type: 'assistant_thinking', runId: 'run-history', sessionId, content: '先并行检查' },
    {
      type: 'assistant_tool_calls',
      runId: 'run-history',
      sessionId,
      content: '',
      toolCalls: [
        { id: 'call-read', name: 'Read', arguments: '{"path":"a"}' },
        { id: 'call-shell', name: 'Shell', arguments: '{"command":"check"}' },
      ],
      providerContinuation: {
        provider: 'openai_codex_subscription',
        issuer: 'issuer-1',
        accountBindingHash: 'binding-1',
        items: [{ type: 'reasoning', encrypted_content: 'opaque-secret' }],
      },
    },
    { type: 'tool_result', runId: 'run-history', sessionId, toolCallId: 'call-read', toolName: 'Read', content: 'read-ok' },
    { type: 'tool_result', runId: 'run-history', sessionId, toolCallId: 'call-shell', toolName: 'Shell', content: 'shell-ok' },
  ], { tenantId: DEFAULT_TENANT_ID });
}

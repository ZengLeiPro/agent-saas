export const CONSOLIDATION_CHAT_PREFIX = 'memory-consolidate-';

export type InternalMemorySessionClass =
  'taskboard' | 'subagent' | 'memory_maintenance' | 'memory_consolidation';

export function classifyInternalMemorySession(
  sessionId: string,
): InternalMemorySessionClass | null {
  if (sessionId.startsWith('taskboard-')) return 'taskboard';
  if (sessionId.startsWith('sub-')) return 'subagent';
  if (sessionId.startsWith('memory-maint-')) return 'memory_maintenance';
  if (sessionId.startsWith(CONSOLIDATION_CHAT_PREFIX)) return 'memory_consolidation';
  return null;
}

import type { PlatformEvent } from '../../runtime/types.js';
import type { ParsedTranscript } from './parse.js';

/**
 * 每个成功 Run 只认最后一条完整 assistant_message 为最终输出。
 * assistant_tool_calls.content 是工具前 commentary；incomplete 是失败时保留的残片，均不参与。
 */
export function collectFinalOutputEventIds(events: readonly PlatformEvent[]): Set<string> {
  const lastCompleteAssistantByRun = new Map<string, string>();
  const finalEventIds = new Set<string>();

  for (const event of events) {
    if (event.type === 'assistant_message') {
      if (!event.incomplete && event.content) {
        lastCompleteAssistantByRun.set(event.runId, event.id);
      }
      continue;
    }
    if (event.type !== 'run_finished') continue;

    if (event.subtype === 'success') {
      const finalEventId = lastCompleteAssistantByRun.get(event.runId);
      if (finalEventId) finalEventIds.add(finalEventId);
    }
    lastCompleteAssistantByRun.delete(event.runId);
  }

  return finalEventIds;
}

export function enrichTranscriptFinalOutputs(
  parsed: ParsedTranscript,
  finalEventIds: ReadonlySet<string>,
): ParsedTranscript {
  let changed = false;
  const blocks = parsed.blocks.map((block) => {
    if (block.kind !== 'text' || !block.sourceEventId || !finalEventIds.has(block.sourceEventId)) {
      return block;
    }
    changed = true;
    return { ...block, finalOutput: true };
  });

  return changed ? { ...parsed, blocks } : parsed;
}

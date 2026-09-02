import type { WsEvent } from '../types/ws';
import type { WsProcessingContext } from './wsEventProcessorHelpers';

const MAX_HANDLED_TERMINAL_KEYS = 500;

/** Claim a terminal frame once per run/client identity while bounding retained keys. */
export function claimTerminalEvent(
  data: Extract<WsEvent, { type: 'done' }>,
  ctx: WsProcessingContext,
): boolean {
  const key = data.runId
    ? `run:${data.runId}`
    : data.client_msg_id
      ? `client:${data.client_msg_id}`
      : null;
  if (!key || !ctx.handledTerminalKeysRef) return true;

  const handled = ctx.handledTerminalKeysRef.current;
  if (handled.has(key)) return false;
  handled.add(key);
  if (handled.size > MAX_HANDLED_TERMINAL_KEYS) {
    const oldest = handled.values().next().value;
    if (oldest) handled.delete(oldest);
  }
  return true;
}

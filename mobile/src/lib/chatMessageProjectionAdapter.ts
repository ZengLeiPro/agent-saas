import {
  adaptWsEventToActivityMessageProjection,
  reduceActivityMessageProjection,
  selectProjectedMessages,
  type ActivityMessageProjectionState,
  type WsEvent,
} from '@agent/shared';

/** Mobile is intentionally a thin rendering adapter; all merge authority lives in shared. */
export function projectMobileChatEvent(state: ActivityMessageProjectionState, event: WsEvent) {
  const canonical = adaptWsEventToActivityMessageProjection(event);
  if (!canonical) return { state, messages: selectProjectedMessages(state) };
  const next = reduceActivityMessageProjection(state, canonical);
  return { state: next, messages: selectProjectedMessages(next) };
}

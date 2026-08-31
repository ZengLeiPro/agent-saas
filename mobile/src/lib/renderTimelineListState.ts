import { captureHistoryAnchor } from '@agent/shared';

export type MobileTimelineScrollCommand = 'none' | 'instant_end' | 'animated_end';

export interface MobileTimelineListState {
  keys: readonly string[];
  nearBottom: boolean;
  initialized: boolean;
  anchorKey?: string;
  visibleSemanticId?: string;
  visibleOffset: number;
  command: MobileTimelineScrollCommand;
}

export type MobileTimelineListEvent =
  | { type: 'data'; keys: readonly string[]; forceFollow?: boolean }
  | { type: 'scroll'; distanceFromBottom: number; nearBottomThreshold: number }
  | { type: 'visible'; semanticId: string; offset?: number }
  | { type: 'command_consumed' };

export const INITIAL_MOBILE_TIMELINE_LIST_STATE: MobileTimelineListState = {
  keys: [],
  nearBottom: true,
  initialized: false,
  visibleOffset: 0,
  command: 'none',
};

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isHistoryPrepend(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length === 0 || next.length <= previous.length) return false;
  const offset = next.length - previous.length;
  return previous.every((key, index) => next[offset + index] === key);
}

/** Pure reducer for stable key, history anchor and near-bottom auto-follow policy. */
export function reduceMobileTimelineList(
  state: MobileTimelineListState,
  event: MobileTimelineListEvent,
): MobileTimelineListState {
  if (event.type === 'scroll') {
    return {
      ...state,
      nearBottom: event.distanceFromBottom < event.nearBottomThreshold,
    };
  }
  if (event.type === 'visible') {
    return { ...state, visibleSemanticId: event.semanticId, visibleOffset: event.offset ?? 0 };
  }
  if (event.type === 'command_consumed') {
    return state.command === 'none' ? state : { ...state, command: 'none' };
  }

  if (event.keys.length === 0) return INITIAL_MOBILE_TIMELINE_LIST_STATE;
  if (!state.initialized) {
    return { keys: [...event.keys], nearBottom: true, initialized: true, visibleOffset: 0, command: 'instant_end' };
  }
  if (isHistoryPrepend(state.keys, event.keys)) {
    const visibleIndex = Math.max(0, state.visibleSemanticId ? state.keys.indexOf(state.visibleSemanticId) : 0);
    const anchor = captureHistoryAnchor(
      { semanticIds: state.keys, offsets: state.keys.map((_, index) => index) },
      visibleIndex,
    );
    return {
      ...state,
      keys: [...event.keys],
      anchorKey: anchor?.semanticId ?? state.keys[0],
      command: 'none',
    };
  }
  const contentChanged = sameKeys(state.keys, event.keys);
  return {
    ...state,
    keys: [...event.keys],
    anchorKey: undefined,
    command: event.forceFollow || state.nearBottom || contentChanged && state.nearBottom
      ? 'animated_end'
      : 'none',
  };
}

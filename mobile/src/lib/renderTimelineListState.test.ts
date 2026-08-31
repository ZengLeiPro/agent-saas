import { describe, expect, it } from 'vitest';
import {
  INITIAL_MOBILE_TIMELINE_LIST_STATE,
  reduceMobileTimelineList,
} from './renderTimelineListState';

describe('M40-02 mobile timeline list reducer', () => {
  it('uses stable semantic keys and scrolls the initial load without animation', () => {
    const state = reduceMobileTimelineList(INITIAL_MOBILE_TIMELINE_LIST_STATE, { type: 'data', keys: ['message:user:1', 'tool:run:call'] });
    expect(state).toMatchObject({ keys: ['message:user:1', 'tool:run:call'], initialized: true, command: 'instant_end' });
  });

  it('auto-follows append/delta only while the user is near the bottom', () => {
    const initial = reduceMobileTimelineList(INITIAL_MOBILE_TIMELINE_LIST_STATE, { type: 'data', keys: ['a'] });
    const consumed = reduceMobileTimelineList(initial, { type: 'command_consumed' });
    const far = reduceMobileTimelineList(consumed, { type: 'scroll', distanceFromBottom: 400, nearBottomThreshold: 150 });
    expect(reduceMobileTimelineList(far, { type: 'data', keys: ['a', 'b'] }).command).toBe('none');
    const near = reduceMobileTimelineList(far, { type: 'scroll', distanceFromBottom: 20, nearBottomThreshold: 150 });
    expect(reduceMobileTimelineList(near, { type: 'data', keys: ['a', 'b'] }).command).toBe('animated_end');
    expect(reduceMobileTimelineList(near, { type: 'data', keys: ['a'] }).command).toBe('animated_end');
  });

  it('keeps the actual first visible semantic key as anchor when history is prepended', () => {
    const initial = { ...INITIAL_MOBILE_TIMELINE_LIST_STATE, initialized: true, keys: ['m3', 'm4'], nearBottom: false };
    const visible = reduceMobileTimelineList(initial, { type: 'visible', semanticId: 'm4', offset: -12 });
    const state = reduceMobileTimelineList(visible, { type: 'data', keys: ['m1', 'm2', 'm3', 'm4'] });
    expect(state).toMatchObject({ anchorKey: 'm4', visibleOffset: -12, command: 'none', nearBottom: false });
  });

  it('force-follow is explicit and does not alter near-bottom observation', () => {
    const state = { ...INITIAL_MOBILE_TIMELINE_LIST_STATE, initialized: true, keys: ['a'], nearBottom: false };
    expect(reduceMobileTimelineList(state, { type: 'data', keys: ['a', 'b'], forceFollow: true })).toMatchObject({ command: 'animated_end', nearBottom: false });
  });
});

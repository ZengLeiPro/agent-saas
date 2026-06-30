/**
 * Connection Slice — WS 连接状态机
 */

import type { StateCreator } from 'zustand';
import type { ChatStore, ConnectionSlice, ConnectionState, ConnectionAction } from '../types';

function reduceConnection(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action) {
    case 'connect':        return 'connected';
    case 'drop':           return 'reconnecting';
    case 'reconnect_ok':   return 'connected';
    case 'reconnect_fail': return 'disconnected';
    case 'complete':       return 'idle';
    case 'reset':          return 'idle';
    default:               return state;
  }
}

export const createConnectionSlice: StateCreator<ChatStore, [], [], ConnectionSlice> = (set, get) => ({
  connectionState: 'idle',

  dispatchConnection(action: ConnectionAction): void {
    const next = reduceConnection(get().connectionState, action);
    if (next !== get().connectionState) {
      set({ connectionState: next });
    }
  },
});

import { useReducer, useCallback } from 'react';

export type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected';
export type ConnectionAction = 'connect' | 'drop' | 'reconnect_ok' | 'reconnect_fail' | 'complete' | 'reset';

function reducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
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

export function useConnectionState() {
  const [state, dispatch] = useReducer(reducer, 'idle');
  const dispatchConnection = useCallback((action: ConnectionAction) => dispatch(action), []);
  return { connectionState: state, dispatchConnection } as const;
}

import React, { createContext, useContext } from 'react';
import { useChatAppStateCore, type ChatAppState } from '../hooks/useChatAppState';

const ChatAppStateContext = createContext<ChatAppState | null>(null);

export function ChatAppStateProvider({ children }: { children: React.ReactNode }) {
  const state = useChatAppStateCore();
  return (
    <ChatAppStateContext.Provider value={state}>
      {children}
    </ChatAppStateContext.Provider>
  );
}

export function useChatAppState(): ChatAppState {
  const ctx = useContext(ChatAppStateContext);
  if (!ctx) {
    throw new Error('useChatAppState must be used within ChatAppStateProvider');
  }
  return ctx;
}

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'agentChat.chatWidth';

export function useChatWidth() {
  const [isWide, setIsWideState] = useState(
    () => localStorage.getItem(STORAGE_KEY) === 'wide',
  );

  const setIsWide = useCallback((wide: boolean) => {
    setIsWideState(wide);
    localStorage.setItem(STORAGE_KEY, wide ? 'wide' : 'narrow');
  }, []);

  return { isWide, setIsWide };
}

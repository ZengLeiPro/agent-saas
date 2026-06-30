import { useState, useCallback } from 'react';

const STORAGE_KEY = 'agentChat.chatFontSize';

export function useChatFontSize() {
  const [isLarge, setIsLargeState] = useState(
    () => localStorage.getItem(STORAGE_KEY) === 'large',
  );

  const setIsLarge = useCallback((large: boolean) => {
    setIsLargeState(large);
    localStorage.setItem(STORAGE_KEY, large ? 'large' : 'small');
  }, []);

  return { isLarge, setIsLarge };
}

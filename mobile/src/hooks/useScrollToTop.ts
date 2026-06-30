import { useRef, useCallback } from 'react';
import type { FlashListRef } from '@shopify/flash-list';

export function useScrollToTop<T>() {
  const listRef = useRef<FlashListRef<T>>(null);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);
  return { listRef, scrollToTop };
}

import { CACHE_KEY_PREFIX, KeyValueAtomicCacheAdapter } from '@agent/shared';
import { webStorage } from './webStorage';

/** localStorage backup bundle uses the shared canonical codec/key builder and one-value commit. */
export const webCacheAdapter = new KeyValueAtomicCacheAdapter(webStorage);

/** Auth owner transitions and recovered logout journals remove every v2 localStorage namespace. */
export function clearWebCacheV2Namespace(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${CACHE_KEY_PREFIX}:`)) localStorage.removeItem(key);
  }
}

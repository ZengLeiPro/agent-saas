import AsyncStorage from '@react-native-async-storage/async-storage';
import { CACHE_KEY_PREFIX, KeyValueAtomicCacheAdapter } from '@agent/shared';
import { mobileStorage } from './mobileStorage';

/** AsyncStorage backup bundle has byte-identical Shared encoding and one-value atomic commit. */
export const mobileCacheAdapter = new KeyValueAtomicCacheAdapter(mobileStorage);

/** Auth owner transitions and recovered logout journals remove every v2 AsyncStorage namespace. */
export async function clearMobileCacheV2Namespace(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(`${CACHE_KEY_PREFIX}:`));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}

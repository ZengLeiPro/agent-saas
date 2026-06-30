import { LogBox } from 'react-native';
import { initPlatform } from '@agent/shared';
import { mobileStorage } from './mobileStorage';
import { mobileSecureStorage } from './mobileSecureStorage';
import { mobileMessageCache } from './mobileMessageCache';
import { mobileConfig } from './mobileConfig';

LogBox.ignoreLogs(['Sending `onAnimatedValueUpdate` with no listeners registered']);

initPlatform({
  storage: mobileStorage,
  secureStorage: mobileSecureStorage,
  messageCache: mobileMessageCache,
  platformConfig: mobileConfig,
  scheduleFlush: (cb) => setTimeout(cb, 0) as unknown as number,
  cancelFlush: (id) => clearTimeout(id),
});

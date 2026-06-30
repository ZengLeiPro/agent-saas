import { initPlatform } from '@agent/shared';
import { webStorage } from './webStorage';
import { webSecureStorage } from './webSecureStorage';
import { webMessageCache } from './webMessageCache';
import { webConfig } from './webConfig';

initPlatform({
  storage: webStorage,
  secureStorage: webSecureStorage,
  messageCache: webMessageCache,
  platformConfig: webConfig,
  scheduleFlush: (cb) => requestAnimationFrame(cb),
  cancelFlush: (id) => cancelAnimationFrame(id),
});

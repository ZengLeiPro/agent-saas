import type { PlatformDeps } from './types';

let _platform: PlatformDeps | null = null;

export function initPlatform(deps: PlatformDeps): void {
  _platform = deps;
}

export function getPlatform(): PlatformDeps {
  if (!_platform) {
    throw new Error('Platform not initialized. Call initPlatform() first.');
  }
  return _platform;
}

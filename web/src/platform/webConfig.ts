import type { IPlatformConfig } from '@agent/shared';

export const webConfig: IPlatformConfig = {
  platform: 'web',
  getBaseUrl(): string {
    return '';
  },
  getWsUrl(token: string | null): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const params = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${protocol}//${host}/ws${params}`;
  },
};

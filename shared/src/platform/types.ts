import type { MessageItem } from '../types/message';

export interface IStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface ISecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface IMessageCache {
  save(sessionId: string, messages: MessageItem[]): void;
  load(sessionId: string): Promise<MessageItem[] | null>;
  clear(sessionId: string): Promise<void>;
}

export interface IPlatformConfig {
  getBaseUrl(): string;
  getWsUrl(token: string | null): string;
  platform: 'web' | 'mobile';
}

export interface PlatformDeps {
  storage: IStorage;
  secureStorage: ISecureStorage;
  messageCache: IMessageCache;
  platformConfig: IPlatformConfig;
  /** Web: requestAnimationFrame, Mobile: setTimeout(cb, 0) */
  scheduleFlush: (callback: () => void) => number;
  /** Web: cancelAnimationFrame, Mobile: clearTimeout */
  cancelFlush: (id: number) => void;
}

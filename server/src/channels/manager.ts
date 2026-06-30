import type { Express } from 'express';
import type { BaseChannel } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';

export class ChannelManager {
  private channels = new Map<string, BaseChannel>();
  private _draining = false;

  /** 聚合所有通道的活跃流计数（duck typing，仅 WebChannel 实现） */
  getActiveStreamCount(): number {
    let total = 0;
    for (const channel of this.channels.values()) {
      if (typeof (channel as any).getActiveStreamCount === 'function') {
        total += (channel as any).getActiveStreamCount();
      }
    }
    return total;
  }

  get draining(): boolean { return this._draining; }
  set draining(v: boolean) { this._draining = v; }

  register(channel: BaseChannel): void {
    this.channels.set(channel.name, channel);
    serverLogger.info(`Channel [${channel.name}] registered`);
  }

  async startAll(app: Express): Promise<void> {
    if (this.channels.size === 0) {
      serverLogger.info('No channels registered');
      return;
    }

    for (const [name, channel] of this.channels) {
      try {
        await channel.start(app);
        serverLogger.info(`Channel [${name}] started`);
      } catch (err) {
        serverLogger.error(`Channel [${name}] failed to start:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
        serverLogger.info(`Channel [${name}] stopped`);
      } catch (err) {
        serverLogger.error(`Channel [${name}] failed to stop:`, err);
      }
    }
  }

  getChannel<T extends BaseChannel>(name: string): T | undefined {
    return this.channels.get(name) as T | undefined;
  }
}

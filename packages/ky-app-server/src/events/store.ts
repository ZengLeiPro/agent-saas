/**
 * §3.7 安装实例状态与事件去重的存储契约与内存实现。
 *
 * 「去重记录、状态变更、ack」必须**同事务**提交，因此提交入口只有 `commit()` 一个。
 */
import type { InstallationState, PlatformEventAck } from '@kaiyan/ky-app-contract';

export interface InstallationStateRecord {
  state: InstallationState;
  /** 单调递增；只接受本地 + 1（§3.7）。 */
  stateVersion: number;
}

export interface InstallationStateStore {
  getState(): Promise<InstallationStateRecord>;
  /** 已处理过的 `eventId` → 上次的 ack（幂等重放）；未处理返回 null。 */
  findAck(eventId: string): Promise<PlatformEventAck | null>;
  /** 单事务：写去重记录 + 落状态 + 落 ack。 */
  commit(input: {
    eventId: string;
    ack: PlatformEventAck;
    state: InstallationStateRecord;
  }): Promise<void>;
}

/** 内存实现：测试与单进程开发用。 */
export class MemoryInstallationStateStore implements InstallationStateStore {
  private record: InstallationStateRecord;
  private readonly acks = new Map<string, PlatformEventAck>();

  constructor(initial: InstallationStateRecord = { state: 'enabled', stateVersion: 0 }) {
    this.record = { ...initial };
  }

  async getState(): Promise<InstallationStateRecord> {
    return { ...this.record };
  }

  async findAck(eventId: string): Promise<PlatformEventAck | null> {
    const ack = this.acks.get(eventId);
    return ack === undefined ? null : { ...ack };
  }

  async commit(input: {
    eventId: string;
    ack: PlatformEventAck;
    state: InstallationStateRecord;
  }): Promise<void> {
    this.acks.set(input.eventId, { ...input.ack });
    this.record = { ...input.state };
  }
}

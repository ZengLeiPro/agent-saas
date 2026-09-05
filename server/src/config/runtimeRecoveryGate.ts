/**
 * 仅由当前恢复事务持有的不可伪造许可。
 *
 * 许可只允许确认已由原 mutation recipe 恢复的精确磁盘文本；普通 refresh、ack 与
 * notify 即使与恢复并发，仍必须看到 dirty 并 fail closed。
 */
export interface ConfigRuntimeRecoveryPermit {
  readonly token: symbol;
}

/**
 * 进程内共享的运行时配置恢复门。
 *
 * 只保存 fail-closed 状态与当前恢复完成许可；恢复 recipe 与事务仍由原
 * mutation/refresher 持有。
 */
export class ConfigRuntimeRecoveryGate {
  private dirty = false;
  private activePermit?: ConfigRuntimeRecoveryPermit;

  isDirty(): boolean {
    return this.dirty;
  }

  markDirty(): void {
    this.dirty = true;
    this.activePermit = undefined;
  }

  beginRecoveryCompletion(): ConfigRuntimeRecoveryPermit {
    if (!this.dirty || this.activePermit) {
      throw new Error('运行时配置恢复门状态无效');
    }
    const permit = Object.freeze({ token: Symbol('config-runtime-recovery') });
    this.activePermit = permit;
    return permit;
  }

  allowsRecoveryCompletion(permit?: ConfigRuntimeRecoveryPermit): boolean {
    return this.dirty && permit !== undefined && permit === this.activePermit;
  }

  completeRecovery(permit: ConfigRuntimeRecoveryPermit): void {
    if (!this.allowsRecoveryCompletion(permit)) {
      throw new Error('运行时配置恢复许可无效');
    }
    this.activePermit = undefined;
    this.dirty = false;
  }

  abortRecovery(permit?: ConfigRuntimeRecoveryPermit): void {
    if (permit === undefined || permit === this.activePermit) {
      this.activePermit = undefined;
    }
    this.dirty = true;
  }
}

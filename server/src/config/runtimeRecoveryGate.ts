/**
 * 进程内共享的运行时配置恢复门。
 *
 * 只保存 fail-closed 状态；恢复 recipe 与事务仍由原 mutation/refresher 持有。
 */
export class ConfigRuntimeRecoveryGate {
  private dirty = false;

  isDirty(): boolean {
    return this.dirty;
  }

  markDirty(): void {
    this.dirty = true;
  }

  clearDirty(): void {
    this.dirty = false;
  }
}

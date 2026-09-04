import {
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
} from '../config/adminConfigMutationService.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';
import { serverLogger } from '../utils/logger.js';

/**
 * 路由级配置写入的最小 Secret ref 生命周期事务。
 *
 * created 只在 put 成功后登记；previous 是本次基线配置引用的受管 ref。
 * 失败清理完全依赖 AdminConfigMutationService 的稳定错误契约：恢复失败保守保留，
 * 其余未提交失败撤销 created。durable commit 后只清理最终配置不再引用的旧 ref。
 */
export class RouteSecretRefMutation {
  private readonly created = new Set<string>();
  private readonly previous = new Set<string>();

  constructor(
    private readonly vault: SecretVault | undefined,
    private readonly caller: VaultCaller,
  ) {}

  get available(): boolean {
    return Boolean(this.vault);
  }

  trackPrevious(refs: Iterable<string | undefined>): void {
    for (const ref of refs) {
      if (ref) this.previous.add(ref);
    }
  }

  async put(
    ownerId: string,
    kind: string,
    value: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    if (!this.vault) throw new Error('SecretVault 未配置，不能保存密钥');
    const ref = await this.vault.putSecret(ownerId, kind, value, this.caller, metadata);
    this.created.add(ref.id);
    return ref.id;
  }

  /** durable/runtime 已提交：保留 created，只撤销最终配置不再引用的旧 ref。 */
  async committed(finalRefs: Iterable<string | undefined>): Promise<number> {
    const referenced = new Set([...finalRefs].filter((ref): ref is string => Boolean(ref)));
    const obsolete = [...this.previous].filter((ref) => !referenced.has(ref));
    this.previous.clear();
    this.created.clear();
    return this.revoke(obsolete);
  }

  /** 按 mutation 错误契约完成清理；返回撤销失败条数，绝不返回 ref 或 vault 错误正文。 */
  async failed(error: unknown, committedRefs: Iterable<string | undefined>): Promise<number> {
    if (error instanceof ConfigMutationCommittedError) return this.committed(committedRefs);
    if (error instanceof RuntimeRestoreFailedError) return 0;
    const abandoned = [...this.created];
    this.created.clear();
    return this.revoke(abandoned);
  }

  redactError(error: unknown, extraValues: Iterable<string | undefined> = []): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of [...this.previous, ...this.created, ...extraValues]) {
      if (value) message = message.replaceAll(value, '[REDACTED]');
    }
    return message;
  }

  private async revoke(refs: Iterable<string>): Promise<number> {
    if (!this.vault) return 0;
    const unique = [...new Set(refs)];
    const outcomes = await Promise.allSettled(
      unique.map((ref) => this.vault!.revokeSecret(ref, this.caller)),
    );
    const failedCount = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (failedCount > 0) {
      serverLogger.warn('Secret ref 清理未完全成功', {
        failedCount,
        attemptedCount: unique.length,
        writer: this.caller.userId,
      });
    }
    return failedCount;
  }
}

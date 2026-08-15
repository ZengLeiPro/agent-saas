import type { WebChannel } from '../channels/web/channel.js';
import type { TenantStore } from '../data/tenants/store.js';
import { runtimeRunController } from '../runtime/runController.js';
import type { RunStore } from '../runtime/runStore.js';

export interface TenantLifecycleChange {
  tenantId: string;
  disabled: boolean;
  actorUserId: string;
  reason: string;
  updatedAt: string;
  /** watcher 发现暂停→恢复发生在两次轮询之间时，保守补做一次断连/取消。 */
  forceSuspendEffect?: boolean;
}

export interface TenantLifecycleEffectResult {
  abortedLocalRuns: number;
  cancelledDurableRuns: number;
}

/**
 * 将已经持久化的组织状态应用到当前进程。
 *
 * 每个 PG EventStore 订阅者都会执行一次：Web 进程断开本地 WS，Worker 进程中止
 * 本地执行控制器；durable run 取消是幂等 SQL，多个实例重复执行不会把终态写回活跃态。
 */
export async function applyTenantLifecycleChange(
  change: TenantLifecycleChange,
  options: {
    tenantStore?: TenantStore;
    webChannel?: Pick<WebChannel, 'disconnectTenant'>;
    runStore?: Pick<RunStore, 'cancelActiveByTenant'>;
    abortTenant?: (tenantId: string, reason?: string) => number;
  },
): Promise<TenantLifecycleEffectResult> {
  options.tenantStore?.reload();
  const current = options.tenantStore?.findByIdStrict(change.tenantId);
  if (options.tenantStore && !current) {
    return { abortedLocalRuns: 0, cancelledDurableRuns: 0 };
  }
  if (!change.forceSuspendEffect && current && Boolean(current.disabled) !== change.disabled) {
    return { abortedLocalRuns: 0, cancelledDurableRuns: 0 };
  }
  if (!change.disabled && !change.forceSuspendEffect) {
    return { abortedLocalRuns: 0, cancelledDurableRuns: 0 };
  }

  const reason = `Tenant disabled: ${change.reason}`;
  options.webChannel?.disconnectTenant(change.tenantId);
  const abortedLocalRuns = (options.abortTenant ?? runtimeRunController.abortByTenant)(change.tenantId, reason);
  const cancelledDurableRuns = await options.runStore?.cancelActiveByTenant?.(change.tenantId, reason) ?? 0;
  return { abortedLocalRuns, cancelledDurableRuns };
}

export class TenantLifecycleWatcher {
  private states = new Map<string, { disabled: boolean; lifecycleUpdatedAt?: string }>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly options: {
    tenantStore: TenantStore;
    onChange: (change: TenantLifecycleChange) => Promise<void>;
    logger?: { warn: (message: string) => void };
    intervalMs?: number;
  }) {}

  start(): void {
    if (this.timer) return;
    try {
      this.states = new Map(
        this.options.tenantStore.listAllStrict()
          .filter(tenant => !tenant.disabled)
          .map(tenant => [tenant.id, {
            disabled: false,
            ...(tenant.lifecycleUpdatedAt ? { lifecycleUpdatedAt: tenant.lifecycleUpdatedAt } : {}),
          }]),
      );
    } catch (error) {
      this.options.logger?.warn(
        `Tenant lifecycle watcher baseline failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.timer = setInterval(() => void this.pollNow(), this.options.intervalMs ?? 250);
    this.timer.unref?.();
    void this.pollNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const tenants = this.options.tenantStore.listAllStrict();
      const nextStates = new Map(tenants.map(tenant => [tenant.id, {
        disabled: Boolean(tenant.disabled),
        ...(tenant.lifecycleUpdatedAt ? { lifecycleUpdatedAt: tenant.lifecycleUpdatedAt } : {}),
      }]));
      for (const tenant of tenants) {
        const previous = this.states.get(tenant.id);
        const disabled = Boolean(tenant.disabled);
        const lifecycleChanged = previous?.lifecycleUpdatedAt !== tenant.lifecycleUpdatedAt;
        if (!previous && !disabled) continue;
        if (previous && previous.disabled === disabled && !lifecycleChanged) continue;

        const baseChange: TenantLifecycleChange = {
          tenantId: tenant.id,
          disabled,
          actorUserId: tenant.lifecycleUpdatedBy ?? tenant.disabledBy ?? 'unknown',
          reason: disabled ? 'shared tenant state changed' : 'shared tenant state restored',
          updatedAt: tenant.updatedAt,
        };
        if (previous && !previous.disabled && !disabled && lifecycleChanged) {
          await this.options.onChange({
            ...baseChange,
            reason: 'missed tenant suspension fence',
            forceSuspendEffect: true,
          });
        } else {
          await this.options.onChange(baseChange);
        }
      }
      const confirmed = this.options.tenantStore.listAllStrict();
      const observedFingerprint = JSON.stringify(tenants.map(tenant => [
        tenant.id, Boolean(tenant.disabled), tenant.lifecycleUpdatedAt ?? null,
      ]));
      const confirmedFingerprint = JSON.stringify(confirmed.map(tenant => [
        tenant.id, Boolean(tenant.disabled), tenant.lifecycleUpdatedAt ?? null,
      ]));
      if (observedFingerprint !== confirmedFingerprint) return;
      this.states = nextStates;
    } catch (error) {
      this.options.logger?.warn(
        `Tenant lifecycle watcher poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.polling = false;
    }
  }
}

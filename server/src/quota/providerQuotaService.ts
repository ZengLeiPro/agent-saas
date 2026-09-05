import type {
  ProviderQuotaHistoryResponse,
  ProviderQuotaOverviewResponse,
  ProviderQuotaSnapshot,
  ProviderQuotaTestRequest,
  ProviderQuotaTestResponse,
} from '@agent/shared';

import type { AppConfig } from '../app/config.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';
import { fetchCodexUsage, normalizeCodexUsage } from './codexSubscriptionQuota.js';
import type { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';
import { fetchVolcengineArkPlanQuota } from './volcengineArkPlanQuota.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;
/** 进程刚起来时模型/凭据热刷新尚未稳定，稍等再采第一轮。 */
const INITIAL_DELAY_MS = 5_000;

type CodexCredentialManagerLike = Pick<
  CodexCredentialManager,
  'getConfiguration' | 'getCredentialRefs' | 'getCredentialsForCredential' | 'getStatuses'
>;

export interface ProviderQuotaServiceOptions {
  store: PgProviderQuotaSnapshotStore;
  /** 读取当前进程最新的模型配置（ws-only 由管理 API 写入，Worker 由 SharedConfigRefresher 对齐）。 */
  getModelsConfig: () => AppConfig['models'];
  secretVault?: SecretVault;
  codexCredentialManager?: CodexCredentialManagerLike;
  /** 只有 singleton Worker 角色跑周期采集；ws-only 进程仅服务按需刷新与读取。 */
  enableCollector: boolean;
  intervalMs?: number;
  retentionDays?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface QuotaSource {
  accountKey: string;
  collect: () => Promise<ProviderQuotaSnapshot>;
}

const vaultReader = (): VaultCaller => ({
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:models:read'],
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 套餐额度采集与读取。数据源随模型配置走：
 * - 模型分组 `quotaSource.provider = volcengine_ark_plan` → 火山管控面 GetAFPUsage/GetPersonalPlan
 * - `codexSubscription.credentialRefs` → 每个已授权 Codex 账号的 wham/usage
 */
export class ProviderQuotaService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderQuotaServiceOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.options.enableCollector || this.timer) return;
    const tick = () => {
      void this.runOnce().catch((error) => {
        this.options.logger.error(`套餐额度采集失败：${errorMessage(error)}`);
      });
    };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
      this.timer.unref?.();
    }, INITIAL_DELAY_MS);
    this.timer.unref?.();
    this.options.logger.info(`套餐额度采集器已启动，间隔 ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 周期采集：拿不到集群单例锁就跳过（另一色 Worker 在采）。 */
  async runOnce(): Promise<ProviderQuotaSnapshot[]> {
    if (this.running) return [];
    const release = await this.options.store.tryAcquireCollectorLock();
    if (!release) return [];
    this.running = true;
    try {
      const snapshots = await this.collectAndPersist();
      await this.options.store.prune(this.retentionDays);
      return snapshots;
    } finally {
      this.running = false;
      await release();
    }
  }

  /** 管理端「立即刷新」：不抢锁，直接采一轮并落库。 */
  async refresh(): Promise<ProviderQuotaSnapshot[]> {
    return this.collectAndPersist();
  }

  async overview(): Promise<ProviderQuotaOverviewResponse> {
    const activeKeys = new Set((await this.sources()).map((source) => source.accountKey));
    const [latest, latestOk] = await Promise.all([
      this.options.store.latest(),
      this.options.store.latestSuccessful(),
    ]);
    const okByKey = new Map(latestOk.map((snapshot) => [snapshot.accountKey, snapshot]));
    const items = latest
      .filter((snapshot) => activeKeys.has(snapshot.accountKey))
      .map((snapshot) => {
        if (snapshot.ok) return snapshot;
        // 失败快照保留上一次成功的窗口数据，只覆盖错误与采集时间。
        const previous = okByKey.get(snapshot.accountKey);
        return previous
          ? {
              ...previous,
              ok: false,
              error: snapshot.error,
              collectedAt: snapshot.collectedAt,
              extra: { ...previous.extra, lastSuccessAt: previous.collectedAt },
            }
          : snapshot;
      })
      .sort(
        (a, b) =>
          a.sourceKind.localeCompare(b.sourceKind) || a.accountLabel.localeCompare(b.accountLabel),
      );
    return {
      items,
      collector: {
        enabled: this.options.enableCollector,
        intervalMs: this.intervalMs,
        lastRunAt: this.lastRunAt,
        lastError: this.lastError,
      },
      generatedAt: this.now().toISOString(),
    };
  }

  async history(hours: number): Promise<ProviderQuotaHistoryResponse> {
    const safeHours = Math.min(Math.max(Math.floor(hours) || 24, 1), 24 * 30);
    const activeKeys = new Set((await this.sources()).map((source) => source.accountKey));
    const points = (await this.options.store.history(safeHours)).filter((point) =>
      activeKeys.has(point.accountKey),
    );
    return { hours: safeHours, points, generatedAt: this.now().toISOString() };
  }

  /** 模型配置页「测试连接」：不落库，Secret 留空时用该分组已保存的 ref。 */
  async test(input: ProviderQuotaTestRequest): Promise<ProviderQuotaTestResponse> {
    const secretAccessKey =
      input.secretAccessKey?.trim() || (await this.storedVolcengineSecret(input.groupId));
    if (!secretAccessKey)
      throw new Error('缺少 Secret Access Key：请填写，或先保存该分组的用量查询配置');
    const result = await fetchVolcengineArkPlanQuota(this.fetchImpl, {
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey,
      region: input.region?.trim() || 'cn-beijing',
    });
    return {
      ...(result.plan ? { plan: result.plan } : {}),
      windows: result.windows,
      limitReached: result.limitReached,
    };
  }

  private async collectAndPersist(): Promise<ProviderQuotaSnapshot[]> {
    const sources = await this.sources();
    const snapshots = await Promise.all(sources.map((source) => source.collect()));
    await this.options.store.append(snapshots);
    this.lastRunAt = this.now().toISOString();
    const failures = snapshots.filter((snapshot) => !snapshot.ok);
    this.lastError =
      failures.length > 0
        ? failures.map((snapshot) => `${snapshot.accountLabel}: ${snapshot.error}`).join('；')
        : null;
    if (failures.length > 0)
      this.options.logger.warn(
        `套餐额度采集 ${failures.length}/${snapshots.length} 个账号失败：${this.lastError}`,
      );
    return snapshots;
  }

  private async storedVolcengineSecret(groupId: string | undefined): Promise<string | undefined> {
    if (!groupId) return undefined;
    const group = this.options.getModelsConfig()?.groups.find((item) => item.id === groupId);
    const source = group?.quotaSource;
    if (!source || source.provider !== 'volcengine_ark_plan') return undefined;
    if (source.secretAccessKey) return source.secretAccessKey;
    if (!source.secretAccessKeyRef) return undefined;
    if (!this.options.secretVault) throw new Error('SecretVault 未配置，无法读取已保存的 Secret');
    return this.options.secretVault.getSecret(source.secretAccessKeyRef, vaultReader());
  }

  private async sources(): Promise<QuotaSource[]> {
    return [...this.volcengineSources(), ...(await this.codexSources())];
  }

  private volcengineSources(): QuotaSource[] {
    const groups = this.options.getModelsConfig()?.groups ?? [];
    return groups.flatMap((group) => {
      const source = group.quotaSource;
      if (!source || source.provider !== 'volcengine_ark_plan') return [];
      const accountKey = `volcengine:${group.id}`;
      const base = {
        sourceKind: 'volcengine_ark_plan' as const,
        accountKey,
        accountLabel: group.name,
        groupId: group.id,
      };
      return [
        {
          accountKey,
          collect: async (): Promise<ProviderQuotaSnapshot> => {
            const collectedAt = this.now().toISOString();
            try {
              const secretAccessKey =
                source.secretAccessKey ??
                (await this.readVaultSecret(
                  source.secretAccessKeyRef,
                  `models.${group.id}.quotaSource`,
                ));
              const result = await fetchVolcengineArkPlanQuota(this.fetchImpl, {
                accessKeyId: source.accessKeyId,
                secretAccessKey,
                region: source.region,
              });
              return {
                ...base,
                ...(result.plan ? { plan: result.plan } : {}),
                windows: result.windows,
                limitReached: result.limitReached,
                ok: true,
                collectedAt,
                ...(result.planError ? { extra: { planError: result.planError } } : {}),
              };
            } catch (error) {
              return {
                ...base,
                windows: [],
                limitReached: false,
                ok: false,
                error: errorMessage(error),
                collectedAt,
              };
            }
          },
        },
      ];
    });
  }

  private async codexSources(): Promise<QuotaSource[]> {
    const manager = this.options.codexCredentialManager;
    if (!manager || !manager.getConfiguration().enabled) return [];
    const refs = manager.getCredentialRefs();
    if (refs.length === 0) return [];
    const statuses = await manager.getStatuses().catch(() => []);
    return refs.map((credentialRef) => {
      const status = statuses.find((item) => item.id === credentialRef);
      const fallbackLabel =
        status?.email ??
        (status?.accountIdHint
          ? `账号 ${status.accountIdHint}`
          : `Codex ${credentialRef.slice(0, 8)}`);
      const accountKey = `codex:${credentialRef}`;
      return {
        accountKey,
        collect: async (): Promise<ProviderQuotaSnapshot> => {
          const collectedAt = this.now().toISOString();
          const base = {
            sourceKind: 'codex_subscription' as const,
            accountKey,
            accountLabel: fallbackLabel,
          };
          try {
            const token = await manager.getCredentialsForCredential(credentialRef);
            const usage = normalizeCodexUsage(await fetchCodexUsage(this.fetchImpl, token));
            return {
              ...base,
              accountLabel: usage.email ?? fallbackLabel,
              ...(usage.planType ? { plan: { type: usage.planType } } : {}),
              windows: usage.windows,
              limitReached: usage.limitReached,
              ok: true,
              collectedAt,
              extra: usage.extra,
            };
          } catch (error) {
            return {
              ...base,
              windows: [],
              limitReached: false,
              ok: false,
              error: errorMessage(error),
              collectedAt,
            };
          }
        },
      };
    });
  }

  private async readVaultSecret(ref: string | undefined, label: string): Promise<string> {
    if (!ref) throw new Error(`${label} 缺少 Secret Access Key`);
    if (!this.options.secretVault) throw new Error(`${label} 需要 SecretVault 才能读取 Secret`);
    return this.options.secretVault.getSecret(ref, vaultReader());
  }
}

import { grokQuotaSources, grokQuotaCredentialStates } from './grokQuotaSources.js';
import type { GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';
import type {
  ProviderQuotaCredentialState,
  ProviderQuotaHistoryResponse,
  ProviderQuotaOverviewResponse,
  ProviderQuotaSnapshot,
  ProviderQuotaTestRequest,
  ProviderQuotaTestResponse,
} from '@agent/shared';
import { isZhipuCodingPlanGroup } from '@agent/shared';

import type { AppConfig } from '../app/config.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';
import { fetchCodexUsage, normalizeCodexUsage } from './codexSubscriptionQuota.js';
import type { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';
import { fetchVolcengineArkPlanQuota } from './volcengineArkPlanQuota.js';
import { fetchZhipuCodingPlanQuota } from './zhipuCodingPlanQuota.js';

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
  grokCredentialManager?: GrokQuotaCredentialSource;
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
  expiryIdentity?: string;
  /** 推送型来源：账号由外部采集端直接写快照表，平台不主动取数，`collect` 缺省。 */
  pushOnly?: true;
  collect?: () => Promise<ProviderQuotaSnapshot>;
}

const vaultReader = (): VaultCaller => ({
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:models:read'],
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function credentialStateOf(status: {
  expiresAt?: string;
  accessTokenExpired?: boolean;
  availability?: ProviderQuotaCredentialState['availability'];
  cooldownUntil?: string;
  lastFailureCode?: string;
}): ProviderQuotaCredentialState {
  return {
    ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
    ...(status.accessTokenExpired !== undefined ? { accessTokenExpired: status.accessTokenExpired } : {}),
    ...(status.availability ? { availability: status.availability } : {}),
    ...(status.cooldownUntil ? { cooldownUntil: status.cooldownUntil } : {}),
    ...(status.lastFailureCode ? { lastFailureCode: status.lastFailureCode } : {}),
  };
}

/**
 * 套餐额度采集与读取。数据源随模型配置走：
 * - 模型分组 `quotaSource.provider = volcengine_ark_plan` → 火山管控面 GetAFPUsage/GetPersonalPlan
 * - 智谱官方地址自动识别，或显式 zhipu_coding_plan → 复用分组 Key 查询账号共享额度
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
  async refresh(accountKey?: string): Promise<ProviderQuotaSnapshot[]> {
    return this.collectAndPersist(accountKey);
  }

  async overview(): Promise<ProviderQuotaOverviewResponse> {
    const sources = await this.sources();
    const activeKeys = new Set(sources.map((source) => source.accountKey));
    const identities = new Map(sources.map((source) => [source.accountKey, source.expiryIdentity]));
    const identityKeys = sources.flatMap((source) => source.expiryIdentity ? [source.expiryIdentity] : []);
    const [overrides, notes] = await Promise.all([
      this.options.store.planExpiryOverrides(identityKeys),
      this.options.store.planNotes(identityKeys),
    ]);
    const [latest, latestOk] = await Promise.all([
      this.options.store.latest(),
      this.options.store.latestSuccessful(),
    ]);
    const okByKey = new Map(latestOk.map((snapshot) => [snapshot.accountKey, snapshot]));
    const liveCredentials = new Map([...await this.codexCredentialStates(), ...await grokQuotaCredentialStates(this.options.grokCredentialManager)]);
    const sourceOrder = new Map(sources.map((source, index) => [source.accountKey, index]));
    const items = latest
      .filter((snapshot) => activeKeys.has(snapshot.accountKey))
      .map((snapshot) => {
        // 失败快照保留上一次成功的窗口数据，只覆盖错误与采集时间。
        const previous = snapshot.ok ? undefined : okByKey.get(snapshot.accountKey);
        const merged = previous
          ? {
              ...previous,
              ok: false,
              error: snapshot.error,
              collectedAt: snapshot.collectedAt,
              extra: { ...previous.extra, lastSuccessAt: previous.collectedAt },
            }
          : snapshot;
        // 凭据/调度状态始终取当前进程的实时值，不用快照里的旧值。
        const credential = liveCredentials.get(merged.accountKey);
        const identity = identities.get(merged.accountKey);
        const manualEndTime = identity ? overrides.get(identity) ?? undefined : undefined;
        const providerEndTime = merged.plan?.endTime;
        const note = identity && notes.has(identity) ? notes.get(identity) ?? undefined : undefined;
        return {
          ...merged,
          ...(credential ? { credential } : {}),
          planExpiry: {
            editable: !!identity,
            endTime: manualEndTime ?? providerEndTime,
            manualEndTime,
            providerEndTime,
            ...(note ? { note } : {}),
          },
        };
      })
      .sort(
        (a, b) =>
          a.sourceKind.localeCompare(b.sourceKind) || (a.sourceKind === 'grok_subscription'
            ? (sourceOrder.get(a.accountKey) ?? 0) - (sourceOrder.get(b.accountKey) ?? 0)
            : a.accountLabel.localeCompare(b.accountLabel)),
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

  async setPlanExpiry(accountKey: string, endTime: string | null, userId: string): Promise<void> {
    const source = (await this.sources()).find((item) => item.accountKey === accountKey);
    if (!source) throw new Error('账号不存在或已移除');
    if (!source.expiryIdentity) throw new Error('尚未取得账号邮箱，无法保存套餐到期时间');
    if (endTime !== null && !Number.isFinite(Date.parse(endTime))) throw new Error('到期时间无效');
    await this.options.store.setPlanExpiry(source.expiryIdentity, endTime, userId);
  }

  async setPlanNote(accountKey: string, note: string | null, userId: string): Promise<void> {
    const source = (await this.sources()).find((item) => item.accountKey === accountKey);
    if (!source) throw new Error('账号不存在或已移除');
    if (!source.expiryIdentity) throw new Error('尚未取得账号邮箱，无法保存套餐备注');
    const normalized = note?.trim() || null;
    await this.options.store.setPlanNote(source.expiryIdentity, normalized, userId);
  }

  async history(hours: number): Promise<ProviderQuotaHistoryResponse> {
    const safeHours = Math.min(Math.max(Math.floor(hours) || 24, 1), 24 * 30);
    const activeKeys = new Set((await this.sources()).map((source) => source.accountKey));
    const points = (await this.options.store.history(safeHours)).filter((point) =>
      activeKeys.has(point.accountKey),
    );
    return { hours: safeHours, points, generatedAt: this.now().toISOString() };
  }

  /** 模型配置页「测试连接」：不落库，凭据留空时使用该分组已保存的值。 */
  async test(input: ProviderQuotaTestRequest): Promise<ProviderQuotaTestResponse> {
    if (input.provider === 'zhipu_coding_plan') {
      const apiKey = input.apiKey?.trim() || (await this.storedZhipuApiKey(input.groupId));
      if (!apiKey) throw new Error('缺少智谱 API Key：请填写，或先保存该模型分组');
      return fetchZhipuCodingPlanQuota(this.fetchImpl, apiKey, this.now());
    }
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

  private async collectAndPersist(accountKey?: string): Promise<ProviderQuotaSnapshot[]> {
    const allSources = await this.sources();
    const matched = accountKey
      ? allSources.filter((source) => source.accountKey === accountKey)
      : allSources;
    if (accountKey && matched.length === 0) throw new Error(`账号不存在或已移除：${accountKey}`);
    // 推送型账号没有可取数的管控面：全量刷新时静默跳过，显式点名时明确拒绝而不是假装采过。
    if (accountKey && matched.every((source) => source.pushOnly)) {
      throw new Error(`该账号由采集端主动上报，平台无法触发刷新：${accountKey}`);
    }
    const sources = matched.filter(
      (source): source is QuotaSource & { collect: () => Promise<ProviderQuotaSnapshot> } =>
        !source.pushOnly && typeof source.collect === 'function',
    );
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

  private async storedZhipuApiKey(groupId: string | undefined): Promise<string | undefined> {
    if (!groupId) return undefined;
    const group = this.options.getModelsConfig()?.groups.find((item) => item.id === groupId);
    if (!group) throw new Error('智谱模型分组不存在或已移除');
    if (group.apiKey?.trim()) return group.apiKey.trim();
    if (!group.apiKeyRef) return undefined;
    if (!this.options.secretVault) throw new Error('SecretVault 未配置，无法读取智谱 API Key');
    try {
      return await this.options.secretVault.getSecret(group.apiKeyRef, vaultReader());
    } catch {
      // Vault 错误可能包含 ref 或底层敏感信息，不写进用量快照/日志。
      throw new Error('无法读取该分组已保存的智谱 API Key，请检查密钥配置');
    }
  }

  private async sources(): Promise<QuotaSource[]> {
    const [codex, grok, claude] = await Promise.all([this.codexSources(), grokQuotaSources(this.options.grokCredentialManager, this.fetchImpl, this.now), this.claudeSources()]);
    return [...this.volcengineSources(), ...this.zhipuSources(), ...codex, ...grok, ...claude];
  }

  /**
   * Claude 订阅：账号不在平台配置里声明，以库中已有快照为准自动发现。
   * 数据由 KY Agent（官方 Agent SDK 会话中带出的 rate limit）直接写入快照表。
   */
  private async claudeSources(): Promise<QuotaSource[]> {
    const accounts = await this.options.store
      .pushedAccounts('claude_subscription')
      .catch((error) => {
        this.options.logger.warn(`Claude 订阅账号发现失败：${errorMessage(error)}`);
        return [] as Array<{ accountKey: string; accountLabel: string }>;
      });
    return accounts.map(({ accountKey }) => {
      const email = accountKey.startsWith('claude:') ? accountKey.slice('claude:'.length) : '';
      return {
        accountKey,
        pushOnly: true as const,
        ...(email && /^[^\s@]+@[^\s@]+$/.test(email)
          ? { expiryIdentity: `claude-email:${email.toLowerCase()}` }
          : {}),
      };
    });
  }

  private async codexCredentialStates(): Promise<Map<string, ProviderQuotaCredentialState>> {
    const manager = this.options.codexCredentialManager;
    if (!manager || !manager.getConfiguration().enabled) return new Map();
    const statuses = await manager.getStatuses().catch(() => []);
    return new Map(
      statuses
        .filter((status) => typeof status.id === 'string')
        .map((status) => [`codex:${status.id}`, credentialStateOf(status)]),
    );
  }

  private zhipuSources(): QuotaSource[] {
    const groups = this.options.getModelsConfig()?.groups ?? [];
    return groups.filter(isZhipuCodingPlanGroup).map((group) => {
      const accountKey = `zhipu:${group.id}`;
      const base = {
        sourceKind: 'zhipu_coding_plan' as const,
        accountKey,
        accountLabel: group.name,
        groupId: group.id,
        // 接口返回账号共享额度；不同 Key/分组可能属于同一账号，不能累加。
        extra: { quotaScope: 'account', attribution: 'shared_across_keys' },
      };
      return {
        accountKey,
        expiryIdentity: accountKey,
        collect: async (): Promise<ProviderQuotaSnapshot> => {
          const collectedAt = this.now().toISOString();
          try {
            const apiKey = await this.storedZhipuApiKey(group.id);
            if (!apiKey) throw new Error('该智谱模型分组尚未配置 API Key');
            const result = await fetchZhipuCodingPlanQuota(this.fetchImpl, apiKey, this.now());
            return { ...base, ...result, ok: true, collectedAt };
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
          expiryIdentity: accountKey,
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
      // 邮箱来自服务端授权状态，不接受客户端指定；同邮箱重新授权/添加可继承设置。
      const email = status?.email?.trim().toLowerCase();
      return {
        accountKey,
        expiryIdentity: email && /^[^\s@]+@[^\s@]+$/.test(email) ? `codex-email:${email}` : undefined,
        collect: async (): Promise<ProviderQuotaSnapshot> => {
          const collectedAt = this.now().toISOString();
          const base = {
            sourceKind: 'codex_subscription' as const,
            accountKey,
            accountLabel: fallbackLabel,
            ...(status ? { credential: credentialStateOf(status) } : {}),
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
              ...(usage.resetCredits !== undefined ? { resetCredits: usage.resetCredits } : {}),
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

/**
 * 网络出口配置 store（2026-07-25）。
 *
 * 模式照 SignupConfigStore：独立 JSON 文件 + configVersion + serialize mutation chain
 * + 原子写(0600) + fail-closed。出口相关的消费方（WebFetch dispatcher、Sandbox Pod env
 * 下发）按 configVersion 感知变化，改完即生效，无需重启 server。
 *
 * 兼容语义：
 *   - 文件不存在 → 用 config.json 的 `egress` 段作 seed（无则全默认关闭）；
 *     不主动写盘，首次 update 才落文件。
 *   - 文件存在 → 文件优先，config.json 的 egress 段仅作首次 seed。
 *   - 代理凭据（user:pass）不进本文件明文：存 secretVault refId（proxyCredentialRef）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { egressConfigSchema } from '../app/config.js';
import {
  DEFAULT_EGRESS_CONFIG,
  isStagingServerEgressSafe,
  type EgressConfig,
} from '../runtime/egressPolicy.js';

interface EgressConfigFileData {
  version: 1;
  /** 每次 update +1；消费方据此感知配置变化并重建运行态 */
  configVersion: number;
  config: EgressConfig;
  /** secretVault refId（global scope, kind='egress-proxy'）；形如 user:pass */
  proxyCredentialRef?: string;
  updatedAt?: string;
  updatedBy?: string;
  /** Sandbox 段最近一次下发到 acs-orchestrator 的结果 */
  sandboxSync?: {
    ok: boolean;
    error?: string;
    syncedAt: string;
  };
}

export interface EgressConfigMeta {
  updatedAt?: string;
  updatedBy?: string;
}

export interface EgressSandboxSyncRecord {
  ok: boolean;
  error?: string;
  syncedAt: string;
}

function defaultConfig(): EgressConfig {
  return egressConfigSchema.parse({}) as EgressConfig;
}

export class EgressConfigStore {
  private data: EgressConfigFileData;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private observedDigest?: string;
  private lastRefreshCheckAt = 0;
  loadFailed = false;

  constructor(
    private readonly filePath: string,
    seed?: EgressConfig,
    private readonly environment?: string,
  ) {
    this.data = {
      version: 1,
      configVersion: 0,
      config: seed ? clone(seed) : defaultConfig(),
    };
    this.load();
    this.assertEnvironmentPolicy(this.data.config);
  }

  getConfig(): EgressConfig {
    this.refreshIfChanged();
    return clone(this.data.config);
  }

  getConfigVersion(): number {
    this.refreshIfChanged();
    return this.data.configVersion;
  }

  isEnvironmentSafetyAttested(): boolean {
    return this.environment !== 'staging' || isStagingServerEgressSafe(this.data.config);
  }

  getProxyCredentialRef(): string | undefined {
    return this.data.proxyCredentialRef;
  }

  getSandboxSync(): EgressSandboxSyncRecord | undefined {
    return this.data.sandboxSync ? { ...this.data.sandboxSync } : undefined;
  }

  getMeta(): EgressConfigMeta {
    return {
      updatedAt: this.data.updatedAt,
      updatedBy: this.data.updatedBy,
    };
  }

  /**
   * 多进程共享目录下，按需吸收其他进程原子写入的新版本。
   * 默认每秒最多检查一次；force 用于测试和显式安全入口。
   */
  refreshIfChanged(force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastRefreshCheckAt < 1_000) return false;
    this.lastRefreshCheckAt = now;
    if (!existsSync(this.filePath)) return false;
    const text = readFileSync(this.filePath, 'utf-8');
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest === this.observedDigest) return false;
    const next = this.parse(text);
    this.assertEnvironmentPolicy(next.config);
    const runtimeChanged =
      next.configVersion !== this.data.configVersion ||
      next.proxyCredentialRef !== this.data.proxyCredentialRef;
    this.data = next;
    this.observedDigest = digest;
    this.loadFailed = false;
    return runtimeChanged;
  }

  /**
   * 全量更新配置（admin API 语义是整表提交，不做深合并）。
   * proxyCredentialRef: undefined = 不动现值；null = 清除；string = 覆盖。
   */
  async update(
    config: EgressConfig,
    opts: { actor: string; proxyCredentialRef?: string | null },
  ): Promise<void> {
    this.assertEnvironmentPolicy(config);
    await this.serialize(async () => {
      this.data.config = clone(config);
      if (opts.proxyCredentialRef === null) {
        delete this.data.proxyCredentialRef;
      } else if (typeof opts.proxyCredentialRef === 'string') {
        this.data.proxyCredentialRef = opts.proxyCredentialRef;
      }
      this.data.updatedAt = new Date().toISOString();
      this.data.updatedBy = opts.actor;
      this.data.configVersion++;
      await this.persist();
    });
  }

  /**
   * 记录 Sandbox 段下发结果。下发失败不回滚配置——配置本身已经是期望态，
   * orchestrator 重启或下次保存会重新拉齐；这里只留可观测痕迹。
   */
  async recordSandboxSync(result: { ok: boolean; error?: string }): Promise<void> {
    await this.serialize(async () => {
      this.data.sandboxSync = {
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        syncedAt: new Date().toISOString(),
      };
      await this.persist();
    });
  }

  private assertEnvironmentPolicy(config: EgressConfig): void {
    if (this.environment === 'staging' && !isStagingServerEgressSafe(config)) {
      throw new Error('staging egress configuration must remain full-proxy and fail-closed');
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const text = readFileSync(this.filePath, 'utf-8');
      this.data = this.parse(text);
      this.observedDigest = createHash('sha256').update(text).digest('hex');
    } catch {
      this.loadFailed = true;
    }
  }

  private parse(text: string): EgressConfigFileData {
    const parsed = JSON.parse(text) as Partial<EgressConfigFileData>;
    const config = egressConfigSchema.safeParse(parsed.config ?? {});
    if (!config.success) throw new Error('egress-config 文件中的 config 段非法');
    return {
      version: 1,
      configVersion: parsed.configVersion ?? 0,
      config: config.data as EgressConfig,
      proxyCredentialRef: parsed.proxyCredentialRef,
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy,
      sandboxSync: parsed.sandboxSync,
    };
  }

  private async persist(): Promise<void> {
    if (this.loadFailed) {
      throw new Error(`egress-config 文件损坏（${this.filePath}），拒绝覆盖写，请人工检查`);
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(
      dirname(this.filePath),
      `.egress-config.${randomBytes(6).toString('hex')}.tmp`,
    );
    const text = JSON.stringify(this.data, null, 2);
    await writeFile(tmpPath, text, {
      mode: 0o600,
    });
    try {
      await rename(tmpPath, this.filePath);
      this.observedDigest = createHash('sha256').update(text).digest('hex');
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

export { DEFAULT_EGRESS_CONFIG };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

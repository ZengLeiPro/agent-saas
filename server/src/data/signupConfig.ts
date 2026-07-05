/**
 * 自助注册动态配置 store（2026-07-06）
 *
 * 背景：selfSignup 原先只活在 config.json（启动读一次 + 被快照进 router 闭包），
 * 改配置必须重启 server——platform-admin 配置页因此做不成"真配置页"。本 store
 * 把 selfSignup 配置落到独立 JSON 文件（模式照 mcpConfig：原子写 + serialize
 * mutation chain + configVersion 计数），signup router 按 version 感知懒重建，
 * 配置改完下一个请求即生效，无需重启。
 *
 * 兼容语义：
 *   - 文件不存在 → 用 config.json 的 auth.selfSignup 作 seed（无则全默认关闭）；
 *     不主动写盘，首次 update 才落文件。
 *   - 文件存在 → 文件优先，config.json 的 selfSignup 段仅作首次 seed。
 *   - SMS AccessKey Secret 不进本文件明文：存 secretVault refId
 *     （smsAccessKeySecretRef），无 ref 时回退 env AGENT_SMS_ACCESS_KEY_SECRET。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { selfSignupConfigSchema, type SelfSignupConfig } from '../app/config.js';

interface SignupConfigFileData {
  version: 1;
  /** 每次 update +1；signup router 据此感知配置变化并重建运行态 */
  configVersion: number;
  config: SelfSignupConfig;
  /** secretVault refId（global scope, kind='signup-sms'）；缺省回退 env */
  smsAccessKeySecretRef?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface SignupConfigMeta {
  updatedAt?: string;
  updatedBy?: string;
}

function defaultConfig(): SelfSignupConfig {
  return selfSignupConfigSchema.parse({});
}

export class SignupConfigStore {
  private data: SignupConfigFileData;
  private mutationChain: Promise<unknown> = Promise.resolve();
  loadFailed = false;

  constructor(
    private readonly filePath: string,
    seed?: SelfSignupConfig,
  ) {
    this.data = {
      version: 1,
      configVersion: 0,
      config: seed ? clone(seed) : defaultConfig(),
    };
    this.load();
  }

  getConfig(): SelfSignupConfig {
    return clone(this.data.config);
  }

  getConfigVersion(): number {
    return this.data.configVersion;
  }

  getSmsAccessKeySecretRef(): string | undefined {
    return this.data.smsAccessKeySecretRef;
  }

  getMeta(): SignupConfigMeta {
    return {
      updatedAt: this.data.updatedAt,
      updatedBy: this.data.updatedBy,
    };
  }

  /**
   * 全量更新配置（admin API 语义是整表提交，不做深合并）。
   * smsAccessKeySecretRef: undefined = 不动现值；null = 清除；string = 覆盖。
   */
  async update(
    config: SelfSignupConfig,
    opts: { actor: string; smsAccessKeySecretRef?: string | null },
  ): Promise<void> {
    await this.serialize(async () => {
      this.data.config = clone(config);
      if (opts.smsAccessKeySecretRef === null) {
        delete this.data.smsAccessKeySecretRef;
      } else if (typeof opts.smsAccessKeySecretRef === 'string') {
        this.data.smsAccessKeySecretRef = opts.smsAccessKeySecretRef;
      }
      this.data.updatedAt = new Date().toISOString();
      this.data.updatedBy = opts.actor;
      this.data.configVersion++;
      await this.persist();
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, 'utf-8'),
      ) as Partial<SignupConfigFileData>;
      const config = selfSignupConfigSchema.safeParse(parsed.config ?? {});
      if (!config.success) {
        // 文件在但 config 段非法：fail-closed（保持默认关闭态），拒绝后续覆盖写，
        // 留给人工修——静默重置会丢管理员配置。
        this.loadFailed = true;
        return;
      }
      this.data = {
        version: 1,
        configVersion: parsed.configVersion ?? 0,
        config: config.data,
        smsAccessKeySecretRef: parsed.smsAccessKeySecretRef,
        updatedAt: parsed.updatedAt,
        updatedBy: parsed.updatedBy,
      };
    } catch {
      this.loadFailed = true;
    }
  }

  private async persist(): Promise<void> {
    if (this.loadFailed) {
      throw new Error(
        `signup-config 文件损坏（${this.filePath}），拒绝覆盖写，请人工检查`,
      );
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(
      dirname(this.filePath),
      `.signup-config.${randomBytes(6).toString('hex')}.tmp`,
    );
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), {
      mode: 0o600,
    });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

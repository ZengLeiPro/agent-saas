import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { parseAppConfig, type AppConfig } from '../app/config.js';
import type { RuntimeEnvironment } from '../release/runtimeIdentity.js';

const LOCK_STALE_MS = 120_000;
const BACKUP_LIMIT = 20;

export class ConfigConflictError extends Error {
  readonly code = 'CONFIG_FINGERPRINT_CONFLICT';
  constructor(readonly currentFingerprint: string, readonly currentRevision?: string) {
    super('配置已被其他管理员更新，请刷新后重试');
  }
}

export interface AdminConfigMutationResult {
  config: AppConfig;
  previousConfig: AppConfig;
  beforeFingerprint: string;
  effectiveConfigFingerprint: string;
  revision: string;
  appliedAt: string;
}

interface MutationInput {
  actor: string;
  changedPaths: string[];
  expectedFingerprint?: string;
  expectedRevision?: string;
  /** 锁内、任何 secret/候选副作用前确认完整磁盘基线。 */
  validateBaseline?: (currentText: string, current: AppConfig) => void | Promise<void>;
  buildCandidate: (
    currentText: string,
    currentRaw: Record<string, unknown>,
  ) => string | Promise<string>;
  /** 写盘前的 Production 安全门禁与异步候选校验。 */
  validateCandidate?: (next: AppConfig) => void | Promise<void>;
  applyRuntime: (next: AppConfig, previous: AppConfig) => void | Promise<void>;
  /** durable/runtime commit 后发布调用方观察面；失败不回滚 durable commit。 */
  onCommitted?: (candidateText: string) => void | Promise<void>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function configFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function configRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseRaw(text: string): Record<string, unknown> {
  const parsed = parseJsonc(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json 根节点必须是对象');
  }
  return parsed as Record<string, unknown>;
}

export class AdminConfigMutationService {
  private readonly stateDir: string;
  private readonly lockPath: string;
  private readonly backupDir: string;
  private readonly auditPath: string;

  constructor(
    private readonly options: {
      configPath: string;
      processCwd: string;
      environment: RuntimeEnvironment;
      processRole: string;
      now?: () => Date;
      /** durable commit 完成后发布实际落盘文本对应的运行时配置身份。 */
      onCommitted?: (candidateText: string) => void | Promise<void>;
    },
  ) {
    this.stateDir = join(options.processCwd, 'data', 'config-governance');
    this.lockPath = join(this.stateDir, 'config.lock');
    this.backupDir = join(this.stateDir, 'backups');
    this.auditPath = join(this.stateDir, 'audit.jsonl');
  }

  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {
    const releaseLock = await this.acquireLock();
    try {
      const currentText = await readFile(this.options.configPath, 'utf8');
      const currentRaw = parseRaw(currentText);
      const previousConfig = parseAppConfig(currentRaw);
      const beforeFingerprint = configFingerprint(currentRaw);
      const beforeRevision = configRevision(currentText);
      if (input.expectedFingerprint && input.expectedFingerprint !== beforeFingerprint) {
        throw new ConfigConflictError(beforeFingerprint, beforeRevision);
      }
      if (input.expectedRevision && input.expectedRevision !== beforeRevision) {
        throw new ConfigConflictError(beforeFingerprint, beforeRevision);
      }
      await input.validateBaseline?.(currentText, previousConfig);
      if (await readFile(this.options.configPath, 'utf8') !== currentText) {
        const latestText = await readFile(this.options.configPath, 'utf8');
        throw new ConfigConflictError(configFingerprint(parseRaw(latestText)), configRevision(latestText));
      }
      const candidateText = await input.buildCandidate(currentText, currentRaw);
      const candidateRaw = parseRaw(candidateText);
      const config = parseAppConfig(candidateRaw);
      await input.validateCandidate?.(config);
      if (await readFile(this.options.configPath, 'utf8') !== currentText) {
        const latestText = await readFile(this.options.configPath, 'utf8');
        throw new ConfigConflictError(configFingerprint(parseRaw(latestText)), configRevision(latestText));
      }
      const effectiveConfigFingerprint = configFingerprint(candidateRaw);
      const appliedAt = (this.options.now?.() ?? new Date()).toISOString();
      if (effectiveConfigFingerprint === beforeFingerprint) {
        return { config, previousConfig, beforeFingerprint, effectiveConfigFingerprint, revision: beforeRevision, appliedAt };
      }

      const backupPath = await this.createBackup(currentText, beforeFingerprint, appliedAt);
      await this.replaceConfig(candidateText);
      try {
        await input.applyRuntime(config, previousConfig);
        const readbackText = await readFile(this.options.configPath, 'utf8');
        const readbackRaw = parseRaw(readbackText);
        if (readbackText !== candidateText || configFingerprint(readbackRaw) !== effectiveConfigFingerprint) {
          throw new ConfigConflictError(configFingerprint(readbackRaw), configRevision(readbackText));
        }
        await this.appendAudit({
          at: appliedAt,
          actor: input.actor,
          environment: this.options.environment,
          processRole: this.options.processRole,
          changedPaths: [...new Set(input.changedPaths)].sort(),
          beforeFingerprint,
          afterFingerprint: effectiveConfigFingerprint,
          result: 'applied',
          backup: basename(backupPath),
        });
      } catch (error) {
        const currentDiskText = await readFile(this.options.configPath, 'utf8').catch(() => undefined);
        const candidateStillOwned = currentDiskText === candidateText;
        if (candidateStillOwned) await this.replaceConfig(currentText);
        await Promise.resolve(input.applyRuntime(previousConfig, config)).catch(() => undefined);
        if (candidateStillOwned) {
          await Promise.resolve(this.options.onCommitted?.(currentText)).catch(() => undefined);
        }
        await this.appendAudit({
          at: (this.options.now?.() ?? new Date()).toISOString(),
          actor: input.actor,
          environment: this.options.environment,
          processRole: this.options.processRole,
          changedPaths: [...new Set(input.changedPaths)].sort(),
          beforeFingerprint,
          afterFingerprint: effectiveConfigFingerprint,
          result: 'rolled_back',
          backup: basename(backupPath),
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        }).catch(() => undefined);
        throw error;
      }
      // 身份/观察面发布失败时响应 fail closed，但 durable/runtime commit 保持，供后续强制刷新收敛。
      await input.onCommitted?.(candidateText);
      await this.options.onCommitted?.(candidateText);
      await this.pruneBackups();
      return { config, previousConfig, beforeFingerprint, effectiveConfigFingerprint, revision: configRevision(candidateText), appliedAt };
    } finally {
      await releaseLock();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        await writeFile(
          join(this.lockPath, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }),
          { flag: 'wx', mode: 0o600 },
        );
        return async () => {
          await rm(this.lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          (error as NodeJS.ErrnoException).code !== 'EEXIST'
        )
          throw error;
        const lockStat = await stat(this.lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
        const currentText = await readFile(this.options.configPath, 'utf8').catch(() => '{}');
        throw new ConfigConflictError(configFingerprint(parseRaw(currentText)), configRevision(currentText));
      }
    }
  }

  private async createBackup(
    text: string,
    fingerprint: string,
    appliedAt: string,
  ): Promise<string> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const timestamp = appliedAt.replace(/[:.]/gu, '-');
    const path = join(this.backupDir, `${timestamp}-${fingerprint.slice(-12)}.jsonc`);
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    return path;
  }

  private async replaceConfig(text: string): Promise<void> {
    const target = this.options.configPath;
    const targetStat = await stat(target);
    const candidate = join(dirname(target), `.${basename(target)}.${randomUUID()}.candidate`);
    await writeFile(candidate, text, { flag: 'wx', mode: targetStat.mode & 0o777 });
    try {
      await rename(candidate, target);
    } catch (error) {
      await unlink(candidate).catch(() => undefined);
      throw error;
    }
  }

  private async appendAudit(record: Record<string, unknown>): Promise<void> {
    await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private async pruneBackups(): Promise<void> {
    const entries = (await readdir(this.backupDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonc'))
      .map((entry) => entry.name)
      .sort();
    const stale = entries.slice(0, Math.max(0, entries.length - BACKUP_LIMIT));
    await Promise.all(stale.map((name) => unlink(join(this.backupDir, name))));
  }
}

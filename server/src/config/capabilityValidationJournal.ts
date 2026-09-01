import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CAPABILITY_IDS,
  type CapabilityId,
  type CapabilityValidationRecord,
} from './capabilityContract.js';
import type { CapabilityValidationLookup } from './capabilityReadiness.js';

/**
 * 最近一次能力验证结果的持久化台账。
 *
 * 只存「什么时候、基于哪份能力配置切片、通过还是失败」，不存请求体、探测响应或
 * 任何凭据材料。状态页据此把「配置合法」和「验证过」区分开：验证记录的指纹与
 * 当前配置切片不一致时视为过期，能力回落到 disabled / incomplete。
 */

const KNOWN_CAPABILITIES = new Set<string>(CAPABILITY_IDS);

function parseRecord(value: unknown): CapabilityValidationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CapabilityValidationRecord>;
  if (record.status !== 'passed' && record.status !== 'failed') return null;
  if (typeof record.validatedAt !== 'string' || typeof record.configFingerprint !== 'string')
    return null;
  return {
    status: record.status,
    validatedAt: record.validatedAt,
    configFingerprint: record.configFingerprint,
  };
}

function readSnapshot(path: string): Map<CapabilityId, CapabilityValidationRecord> {
  const records = new Map<CapabilityId, CapabilityValidationRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 首次启动或文件损坏：台账不是事实源，缺失时按「从未验证」处理即可。
    return records;
  }
  if (!parsed || typeof parsed !== 'object') return records;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_CAPABILITIES.has(key)) continue;
    const record = parseRecord(value);
    if (record) records.set(key as CapabilityId, record);
  }
  return records;
}

export class CapabilityValidationJournal implements CapabilityValidationLookup {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly records: Map<CapabilityId, CapabilityValidationRecord>;
  private readonly inFlight = new Set<CapabilityId>();
  /** 串行化落盘，避免并发启用互相覆盖台账。 */
  private writes: Promise<void> = Promise.resolve();

  constructor(options: { processCwd: string; now?: () => Date }) {
    this.path = join(
      options.processCwd,
      'data',
      'config-governance',
      'capability-validations.json',
    );
    this.now = options.now ?? (() => new Date());
    this.records = readSnapshot(this.path);
  }

  record(capability: CapabilityId): CapabilityValidationRecord | undefined {
    return this.records.get(capability);
  }

  isValidating(capability: CapabilityId): boolean {
    return this.inFlight.has(capability);
  }

  /** 标记能力进入验证中；返回的函数必须在 finally 里调用。 */
  beginValidation(capability: CapabilityId): () => void {
    this.inFlight.add(capability);
    return () => this.inFlight.delete(capability);
  }

  async recordResult(
    capability: CapabilityId,
    status: CapabilityValidationRecord['status'],
    configFingerprint: string,
  ): Promise<void> {
    this.records.set(capability, {
      status,
      validatedAt: this.now().toISOString(),
      configFingerprint,
    });
    await this.flush();
  }

  snapshot(): Record<string, CapabilityValidationRecord> {
    return Object.fromEntries(
      [...this.records].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  private async flush(): Promise<void> {
    const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    this.writes = this.writes.then(() => this.writeAtomic(payload)).catch(() => undefined);
    await this.writes;
  }

  private async writeAtomic(payload: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const candidate = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(candidate, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(candidate, this.path);
    } catch (error) {
      await unlink(candidate).catch(() => undefined);
      throw error;
    }
  }
}

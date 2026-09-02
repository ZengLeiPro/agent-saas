import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

function decodeSnapshot(text: string): Map<CapabilityId, CapabilityValidationRecord> {
  const records = new Map<CapabilityId, CapabilityValidationRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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

function readSnapshotSync(path: string): Map<CapabilityId, CapabilityValidationRecord> {
  try {
    return decodeSnapshot(readFileSync(path, 'utf8'));
  } catch {
    // 首次启动或文件损坏：台账不是事实源，缺失时按「从未验证」处理即可。
    return new Map();
  }
}

async function readSnapshotAsync(
  path: string,
): Promise<Map<CapabilityId, CapabilityValidationRecord>> {
  try {
    return decodeSnapshot(await readFile(path, 'utf8'));
  } catch {
    return new Map();
  }
}

export class CapabilityValidationJournal implements CapabilityValidationLookup {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly records: Map<CapabilityId, CapabilityValidationRecord>;
  private readonly inFlight = new Set<CapabilityId>();
  /** 本进程写过的能力；落盘合并时以本进程的值为准，其余沿用磁盘上的。 */
  private readonly owned = new Set<CapabilityId>();
  /** 串行化落盘，避免本进程内的并发启用互相覆盖台账。 */
  private writes: Promise<void> = Promise.resolve();

  constructor(options: { processCwd: string; now?: () => Date }) {
    this.path = join(
      options.processCwd,
      'data',
      'config-governance',
      'capability-validations.json',
    );
    this.now = options.now ?? (() => new Date());
    this.records = readSnapshotSync(this.path);
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
    this.owned.add(capability);
    await this.flush();
  }

  snapshot(): Record<string, CapabilityValidationRecord> {
    return Object.fromEntries(
      [...this.records].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  /**
   * 落盘失败必须让调用方知道：只写进内存的验证记录重启后就没了，把它当成成功
   * 会让状态页长期显示一个其实不存在的「已验证」。
   *
   * 单次失败不能毒化写队列，所以链条本身吞掉异常，但本次 flush 照常抛出。
   */
  private async flush(): Promise<void> {
    const write = this.writes.then(() => this.persist());
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  /**
   * 多实例部署下台账是「按能力最后写入者胜出」：先并入磁盘上其他进程写的记录，
   * 再覆盖本进程写过的能力，最后整体原子替换。不是跨进程强一致，但不会因为
   * 另一个实例先写而把它的结果整份抹掉。
   */
  private async persist(): Promise<void> {
    for (const [capability, record] of await readSnapshotAsync(this.path)) {
      if (!this.owned.has(capability)) this.records.set(capability, record);
    }
    await this.writeAtomic(`${JSON.stringify(this.snapshot(), null, 2)}\n`);
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

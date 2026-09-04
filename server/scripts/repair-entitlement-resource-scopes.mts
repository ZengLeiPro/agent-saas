import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { governanceDigest, PgGovernanceAuditStore } from '../src/data/governance-audit/index.js';
import {
  ENTITLEMENT_RESOURCE_TYPES,
  PgEntitlementStore,
  type EntitlementResourceType,
} from '../src/data/entitlements/index.js';
import {
  DEFAULT_TENANT_SETTINGS,
  PLATFORM_TENANT_ID,
  type TenantRecord,
} from '../src/data/tenants/types.js';

const SERVER_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface RepairArgs {
  apply: boolean;
  fillMissing: boolean;
  tenantId: string;
  reason: string;
  tablePrefix: string;
  tenantsFile: string;
  confirmTenantId?: string;
  remove?: { resourceType: EntitlementResourceType; resourceId: string };
  expectedVersion?: number;
  catalogFile?: string;
}

export function parseRepairArgs(argv: readonly string[]): RepairArgs {
  const values = new Map<string, string>();
  let apply = false;
  let fillMissing = false;
  for (const argument of argv) {
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--fill-missing') {
      fillMissing = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`未知参数：${argument}`);
    if (values.has(match[1]!)) throw new Error(`参数不可重复：--${match[1]}`);
    values.set(match[1]!, match[2]!);
  }
  for (const key of values.keys()) {
    if (
      ![
        'tenant',
        'reason',
        'table-prefix',
        'tenants-file',
        'confirm-tenant',
        'remove-stale-id',
        'expected-version',
        'catalog-file',
      ].includes(key)
    )
      throw new Error(`未知参数：--${key}`);
  }
  const tenantId = required(values, 'tenant');
  const reason = required(values, 'reason');
  const removeRaw = values.get('remove-stale-id');
  let remove: RepairArgs['remove'];
  if (removeRaw) {
    const separator = removeRaw.indexOf(':');
    const resourceType = removeRaw.slice(0, separator) as EntitlementResourceType;
    const resourceId = removeRaw.slice(separator + 1);
    if (
      separator < 1 ||
      !(ENTITLEMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType) ||
      !resourceId
    ) {
      throw new Error('--remove-stale-id 格式必须为 resourceType:resourceId');
    }
    remove = { resourceType, resourceId };
  }
  if (!fillMissing && !remove) throw new Error('必须指定 --fill-missing 或 --remove-stale-id');
  const expectedRaw = values.get('expected-version');
  if (expectedRaw && (!/^\d+$/.test(expectedRaw) || Number(expectedRaw) < 1)) {
    throw new Error('--expected-version 必须是正整数');
  }
  if (apply && values.get('confirm-tenant') !== tenantId) {
    throw new Error('--apply 必须同时提供与 --tenant 完全一致的 --confirm-tenant');
  }
  if (apply && remove && !expectedRaw)
    throw new Error('清理旧 ID 的 --apply 必须提供 --expected-version');
  if (remove && !values.get('catalog-file'))
    throw new Error('清理旧 ID 必须提供 --catalog-file 权威目录快照');
  return {
    apply,
    fillMissing,
    tenantId,
    reason,
    tablePrefix: values.get('table-prefix') ?? 'runtime',
    tenantsFile: values.get('tenants-file')
      ? resolve(values.get('tenants-file')!)
      : resolve(SERVER_DIR, 'data/tenants.json'),
    ...(values.get('confirm-tenant') ? { confirmTenantId: values.get('confirm-tenant') } : {}),
    ...(remove ? { remove } : {}),
    ...(expectedRaw ? { expectedVersion: Number(expectedRaw) } : {}),
    ...(values.get('catalog-file') ? { catalogFile: resolve(values.get('catalog-file')!) } : {}),
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}=...`);
  return value;
}

function tenantRecord(path: string, tenantId: string): TenantRecord {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tenants?: TenantRecord[] };
  const tenant = parsed.tenants?.find((item) => item.id === tenantId);
  if (!tenant) throw new Error(`目标组织不在 tenants 文件中：${tenantId}`);
  return tenant;
}

function assertStale(path: string, resourceType: EntitlementResourceType, resourceId: string) {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const raw = parsed[resourceType];
  if (!Array.isArray(raw)) throw new Error(`目录快照缺少数组：${resourceType}`);
  const ids = raw.map((item) =>
    typeof item === 'string' ? item : String((item as { resourceId?: unknown }).resourceId ?? ''),
  );
  if (ids.includes(resourceId))
    throw new Error(`资源仍在权威目录中，禁止按旧 ID 清理：${resourceId}`);
}

export async function repairEntitlementResourceScopes(input: { pool: Pool; args: RepairArgs }) {
  const { args, pool } = input;
  if (args.tenantId === PLATFORM_TENANT_ID) throw new Error('平台租户不适用组织 Entitlement 修复');
  const store = new PgEntitlementStore({
    pool,
    tablePrefix: args.tablePrefix,
    platformTenantId: PLATFORM_TENANT_ID,
  });
  const tenant = tenantRecord(args.tenantsFile, args.tenantId);
  const before = await store.listResourceScopes(args.tenantId);
  if (args.remove) {
    assertStale(args.catalogFile!, args.remove.resourceType, args.remove.resourceId);
    const scope = before.find((item) => item.resourceType === args.remove!.resourceType);
    if (!scope?.resourceIds.includes(args.remove.resourceId)) {
      return {
        mode: args.apply ? 'apply' : 'dry-run',
        changed: false,
        reason: '指定旧 ID 当前不存在',
        backup: before,
      };
    }
    if (args.apply && scope.version !== args.expectedVersion) {
      throw new Error(
        `ENTITLEMENT_SCOPE_VERSION_CONFLICT: expected=${args.expectedVersion} actual=${scope.version}`,
      );
    }
  }
  const plan = {
    mode: args.apply ? 'apply' : 'dry-run',
    tenantId: args.tenantId,
    reason: args.reason,
    fillMissing: args.fillMissing,
    remove: args.remove ?? null,
    backup: before,
  };
  if (!args.apply) return plan;

  const changeId = randomUUID();
  if (args.fillMissing) {
    await store.backfillMissingResourceScopes({
      tenants: [{ ...tenant, settings: tenant.settings ?? DEFAULT_TENANT_SETTINGS }],
      platformTenantId: PLATFORM_TENANT_ID,
      createdBy: 'system:entitlement-scope-repair',
    });
  }
  if (args.remove) {
    const scope = (await store.listResourceScopes(args.tenantId)).find(
      (item) => item.resourceType === args.remove!.resourceType,
    );
    if (!scope || scope.version !== args.expectedVersion) {
      throw new Error('ENTITLEMENT_SCOPE_VERSION_CONFLICT');
    }
    await store.replaceResourceScope(args.tenantId, args.remove.resourceType, {
      mode: scope.mode,
      resourceIds: scope.resourceIds.filter((id) => id !== args.remove!.resourceId),
      expectedVersion: scope.version,
      updatedBy: 'system:entitlement-scope-repair',
    });
  }
  const after = await store.listResourceScopes(args.tenantId);
  try {
    const audit = await new PgGovernanceAuditStore({ pool, tablePrefix: args.tablePrefix }).append({
      correlationId: changeId,
      changeId,
      actorType: 'service',
      actorUserId: 'system:entitlement-scope-repair',
      actorPersona: 'service',
      actorTenantId: PLATFORM_TENANT_ID,
      action: 'entitlement_scope_repair',
      targetType: 'tenant',
      targetId: args.tenantId,
      targetTenantId: args.tenantId,
      purpose: 'bounded_entitlement_scope_repair',
      reason: args.reason,
      beforeDigest: governanceDigest(before),
      afterDigest: governanceDigest(after),
      result: 'succeeded',
      metadata: { fillMissing: args.fillMissing, resourceType: args.remove?.resourceType ?? null },
    });
    return {
      ...plan,
      changed: governanceDigest(before) !== governanceDigest(after),
      changeId,
      auditId: audit.auditId,
      after,
    };
  } catch (error) {
    throw new Error(
      `GOVERNANCE_PARTIAL_CHANGE changeId=${changeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  const args = parseRepairArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    console.log(JSON.stringify(await repairEntitlementResourceScopes({ pool, args }), null, 2));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

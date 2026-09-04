import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { ENTITLEMENT_RESOURCE_TYPES, PgEntitlementStore } from '../src/data/entitlements/index.js';
import { PLATFORM_TENANT_ID } from '../src/data/tenants/types.js';

const SERVER_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface AuditArgs {
  tablePrefix: string;
  tenantsFile: string;
  tenantId?: string;
  catalogFile?: string;
}

export function parseAuditArgs(argv: readonly string[]): AuditArgs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`未知参数：${argument}`);
    values.set(match[1]!, match[2]!);
  }
  for (const key of values.keys()) {
    if (!['table-prefix', 'tenants-file', 'tenant', 'catalog-file'].includes(key)) {
      throw new Error(`未知参数：--${key}`);
    }
  }
  return {
    tablePrefix: values.get('table-prefix') ?? 'runtime',
    tenantsFile: values.get('tenants-file')
      ? resolve(values.get('tenants-file')!)
      : resolve(SERVER_DIR, 'data/tenants.json'),
    ...(values.get('tenant') ? { tenantId: values.get('tenant') } : {}),
    ...(values.get('catalog-file') ? { catalogFile: resolve(values.get('catalog-file')!) } : {}),
  };
}

function readTenantIds(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tenants?: Array<{ id?: string }> };
  return (parsed.tenants ?? [])
    .map((item) => item.id?.trim() ?? '')
    .filter((id) => id && id !== PLATFORM_TENANT_ID);
}

function readCatalog(path: string | undefined): Map<string, Set<string>> | null {
  if (!path) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const result = new Map<string, Set<string>>();
  for (const resourceType of ENTITLEMENT_RESOURCE_TYPES) {
    const raw = parsed[resourceType];
    if (!Array.isArray(raw)) throw new Error(`目录快照缺少数组：${resourceType}`);
    result.set(
      resourceType,
      new Set(
        raw
          .map((item) =>
            typeof item === 'string'
              ? item
              : String((item as { resourceId?: unknown }).resourceId ?? ''),
          )
          .filter(Boolean),
      ),
    );
  }
  return result;
}

export async function auditEntitlementResourceScopes(input: {
  pool: Pool;
  args: AuditArgs;
}): Promise<Record<string, unknown>> {
  const store = new PgEntitlementStore({
    pool: input.pool,
    tablePrefix: input.args.tablePrefix,
    platformTenantId: PLATFORM_TENANT_ID,
  });
  const catalog = readCatalog(input.args.catalogFile);
  const tenantIds = input.args.tenantId
    ? [input.args.tenantId]
    : [...new Set(readTenantIds(input.args.tenantsFile))].sort();
  const organizations: Array<Record<string, unknown>> = [];
  for (const tenantId of tenantIds) {
    try {
      const scopes = await store.listResourceScopes(tenantId);
      const byType = new Map(scopes.map((scope) => [scope.resourceType, scope]));
      organizations.push({
        tenantId,
        missingResourceTypes: ENTITLEMENT_RESOURCE_TYPES.filter((type) => !byType.has(type)),
        scopes: ENTITLEMENT_RESOURCE_TYPES.flatMap((resourceType) => {
          const scope = byType.get(resourceType);
          if (!scope) return [];
          const ids = catalog?.get(resourceType);
          return [
            {
              resourceType,
              mode: scope.mode,
              resourceIds: scope.resourceIds,
              staleResourceIds: ids ? scope.resourceIds.filter((id) => !ids.has(id)) : null,
              catalogStatus: ids ? 'available' : 'unavailable',
              version: scope.version,
              source: scope.source,
              updatedAt: scope.updatedAt,
            },
          ];
        }),
      });
    } catch (error) {
      organizations.push({
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    mode: 'read-only',
    tablePrefix: input.args.tablePrefix,
    catalogSnapshot: input.args.catalogFile ?? null,
    organizations,
    summary: {
      organizationsScanned: organizations.length,
      organizationsWithErrors: organizations.filter((item) => item.error).length,
      missingScopeRows: organizations.reduce(
        (sum, item) => sum + ((item.missingResourceTypes as unknown[] | undefined)?.length ?? 0),
        0,
      ),
    },
  };
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    console.log(JSON.stringify(await auditEntitlementResourceScopes({ pool, args }), null, 2));
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

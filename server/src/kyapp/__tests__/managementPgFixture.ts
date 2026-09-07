/** 本地验收装配：真实 PG / Express 路由；身份仅供测试，不启动 worker 或读取生产配置。 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import type { AddressInfo } from 'node:net';
import { registerKyAppRoutes } from '../../app/kyAppRoutes.js';
import type { AppRuntime } from '../../app/runtime.js';
import { PgAssignmentStore } from '../../data/assignments/store.js';
import { PgMembershipStore } from '../../data/memberships/store.js';
import { PgEntitlementStore } from '../../data/entitlements/store.js';
import { PgGovernanceAuditStore } from '../../data/governance-audit/store.js';
import { DEFAULT_TENANT_SETTINGS } from '../../data/tenants/types.js';
import { InMemorySecretVault } from '../../security/secretVault.js';
import { PLATFORM_ADMIN, ORG_ADMIN, MEMBER, OTHER_TENANT_ADMIN } from './harness.js';

export async function createManagementPgFixture(url: string) {
  const prefix = `p0flow_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pool = new pg.Pool({ connectionString: url });
  const base = { pool, tablePrefix: prefix };
  const assignments = new PgAssignmentStore(base);
  await assignments.init();
  const memberships = new PgMembershipStore(base);
  const entitlements = new PgEntitlementStore(base);
  const audit = new PgGovernanceAuditStore(base);
  const identities = {
    platform: PLATFORM_ADMIN,
    reviewer: { ...PLATFORM_ADMIN, sub: 'reviewer' },
    org: ORG_ADMIN,
    member: MEMBER,
    unassigned: { ...MEMBER, sub: 'unassigned' },
    other: OTHER_TENANT_ADMIN,
  };
  for (const identity of Object.values(identities).filter((user) => user.tenantId !== 'pantheon')) {
    await memberships.createMembership({
      tenantId: identity.tenantId,
      userId: identity.sub,
      persona: identity.role === 'admin' ? 'org_admin' : 'member',
      createdBy: 'fixture',
    });
  }
  await entitlements.provisionTenantGovernance({
    tenantId: ORG_ADMIN.tenantId,
    settings: DEFAULT_TENANT_SETTINGS,
    createdBy: 'fixture',
  });
  const eventsTable = `${prefix}_test_events`;
  await pool.query(
    `CREATE TABLE ${eventsTable} (tenant_id TEXT, event_type TEXT, event_json JSONB, timestamp TIMESTAMPTZ DEFAULT NOW())`,
  );
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const id = String(req.headers['x-test-identity'] ?? '');
    req.user = identities[id as keyof typeof identities];
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });
  const assembly = registerKyAppRoutes(
    app,
    {
      runtimePgEventStore: { pool, eventsTable },
      secretVault: new InMemorySecretVault(),
      config: { runtimeEventStore: { backend: 'pg', tablePrefix: prefix } },
      assignmentStore: assignments,
      membershipStore: memberships,
      entitlementStore: entitlements,
      governanceAuditStore: audit,
    } as unknown as AppRuntime,
    {
      autoStart: false,
      rawConfig: {
        kyApp: {
          environment: 'local',
          publicIssuer: 'http://127.0.0.1:4194',
          allowInsecureOutbound: true,
        },
      },
    },
  );
  if (!assembly) throw new Error('本地验收装配失败');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    assembly,
    pool,
    prefix,
    assignments,
    memberships,
    entitlements,
    identities,
    origin,
    request(path: string, identity: keyof typeof identities, method = 'GET', body?: unknown) {
      return fetch(`${origin}${path}`, {
        method,
        headers: { 'x-test-identity': identity, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    async close() {
      assembly.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const tables = await pool.query(
        'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND starts_with(tablename,$1)',
        [prefix + '_'],
      );
      for (const row of tables.rows) await pool.query(`DROP TABLE "${row.tablename}" CASCADE`);
      await pool.end();
    },
  };
}

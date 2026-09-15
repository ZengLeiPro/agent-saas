import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { governanceV41KyAppSystemStatements } from '../../data/governance-schema/v41KyAppSystemMigration.js';
import { governanceV44KyAppDeliveryStatements } from '../../data/governance-schema/v44KyAppDeliveryMigration.js';
import { governanceV45KyAppConnectionSettingsStatements } from '../../data/governance-schema/v45KyAppConnectionSettingsMigration.js';
import { PgKyAppSystemStore } from '../systems/store.js';
import { PgKyAppDeliveryStore } from './store.js';
import {
  PgKyAppConnectionSettingsStore,
  validateConnectionSettings,
} from './connectionSettings.js';
import { KyAppExistingOnboardService, type ExistingOnboardOptions } from './existingOnboard.js';
import { KyAppInstallationService } from '../installations/service.js';
import { KyAppManagementQueries } from '../installations/managementQueries.js';
import { createKyAppExistingOnboardRouter } from '../routes/existingOnboard.js';
import { resolveKyAppConfig } from '../config.js';
import {
  buildManifest,
  PLATFORM_ADMIN,
  MEMBER,
  ORG_ADMIN,
  TEST_SYSTEM,
} from '../__tests__/harness.js';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('已有组织接入 HTTP 与 PostgreSQL', () => {
  const prefix = `exorg_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const systems = new PgKyAppSystemStore({ pool, tablePrefix: prefix });
  const store = new PgKyAppDeliveryStore(pool, prefix);
  const settings = new PgKyAppConnectionSettingsStore(pool, prefix);
  const config = resolveKyAppConfig({ kyApp: { environment: 'staging' } })!;
  const audit = { append: vi.fn().mockImplementation(async () => ({ auditId: randomUUID() })) };
  let digest: string;
  let sequence = 0;
  const servers: Server[] = [];
  beforeAll(async () => {
    await pool.query(
      `CREATE TABLE ${prefix}_resource_assignments (assignment_id TEXT PRIMARY KEY,resource_type TEXT NOT NULL)`,
    );
    for (const sql of [
      ...governanceV41KyAppSystemStatements(prefix),
      ...governanceV44KyAppDeliveryStatements(prefix),
      ...governanceV45KyAppConnectionSettingsStatements(prefix),
    ])
      await pool.query(sql);
    // expand migration 可重复执行，不影响已有版本。
    for (const sql of governanceV45KyAppConnectionSettingsStatements(prefix)) await pool.query(sql);
    const registered = await systems.registerVersion({
      systemId: TEST_SYSTEM,
      name: '演示 ERP',
      manifest: buildManifest(),
      actor: PLATFORM_ADMIN.sub,
    });
    digest = registered.version.digest;
    await systems.publishVersion({
      systemId: TEST_SYSTEM,
      digest,
      expectedVersion: registered.definition.version,
      actor: PLATFORM_ADMIN.sub,
    });
    await settings.save(
      TEST_SYSTEM,
      {
        baseUrl: 'https://{tenantId}.apps.kaiyancn.com',
        origin: 'https://{tenantId}.apps.kaiyancn.com',
        diagnostic: { readOnlyCapabilityId: 'order.search', readOnlyInput: { keyword: '' } },
      },
      0,
      PLATFORM_ADMIN.sub,
    );
  });
  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const tables = await pool.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND starts_with(tablename,$1)',
      [prefix + '_'],
    );
    for (const row of tables.rows) await pool.query(`DROP TABLE "${row.tablename}" CASCADE`);
    await pool.end();
  });
  function rig() {
    const tenantId = `org-${++sequence}`;
    const state = {
      active: true,
      tenantDisabled: false,
      userDisabled: false,
      userTenant: tenantId,
      acked: false,
      assigned: false,
      ready: false,
      dns: false,
    };
    let issued = false;
    const membership = {
      tenantId,
      userId: 'contact',
      status: 'active',
      persona: 'org_admin',
      isOwner: true,
    };
    const memberships = {
      getMembership: vi.fn(async (_tenantId: string, userId: string) =>
        userId === 'contact'
          ? { ...membership, status: state.active ? 'active' : 'disabled' }
          : null,
      ),
      listMemberships: vi.fn(async () => [
        { ...membership, status: state.active ? 'active' : 'disabled' },
      ]),
    };
    const installations = new KyAppInstallationService({
      config,
      systems,
      memberships: memberships as never,
      audit: audit as never,
      events: { enqueue: vi.fn() } as never,
      resolveTxt: async () =>
        state.dns
          ? [[(await systems.listInstallationsForTenant(tenantId))[0]!.domainVerificationToken!]]
          : [],
    });
    const issue = vi.fn(async () => {
      issued = true;
      return {
        credentialId: 'cred',
        ticket: 'one-time-value',
        ticketExpiresAt: '2026-09-09T00:00:00Z',
        ackDeadlineAt: '2026-09-10T00:00:00Z',
      };
    });
    const options = {
      config,
      systems,
      store,
      settings,
      installations,
      tenants: {
        findByIdStrict: (id: string) =>
          id === tenantId ? { id, name: '已有组织', disabled: state.tenantDisabled } : undefined,
        listAllStrict: () => [{ id: tenantId, name: '已有组织', disabled: state.tenantDisabled }],
      },
      users: {
        findById: (id: string) =>
          id === 'contact'
            ? {
                id,
                tenantId: state.userTenant,
                username: 'existing-user',
                realName: '已有管理员',
                disabled: state.userDisabled,
              }
            : undefined,
      },
      memberships,
      credentials: {
        listMetadata: async () =>
          issued ? [{ credentialId: 'cred', status: state.acked ? 'active' : 'pending_ack' }] : [],
        issue,
      },
      runtimeStore: {
        get: async () => ({ readyStatus: state.ready ? 'ok' : 'failed', manifestDigest: digest }),
      },
      getAssignmentConfigured: async () => state.assigned,
      runSmoke: vi.fn(async () => ({
        passed: true,
        checks: [],
        installationId: '',
        checkedAt: '',
      })),
    } as unknown as ExistingOnboardOptions;
    const service = new KyAppExistingOnboardService(options);
    const input = {
      systemId: TEST_SYSTEM,
      tenantId,
      techContactUserId: 'contact',
      expectedSettingsVersion: 1,
      expectedDigest: digest,
    };
    return { service, input, state, issue, options };
  }
  it('复用无手机号的已有成员，并发提交只建一个安装且只签发一次凭据', async () => {
    const r = rig();
    const [first, second] = await Promise.all([
      r.service.start(r.input, PLATFORM_ADMIN),
      r.service.start(r.input, PLATFORM_ADMIN),
    ]);
    expect(first.execution.installationId).toBe(second.execution.installationId);
    expect(r.issue).toHaveBeenCalledTimes(1);
    expect([first.claim, second.claim].filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify(first.execution)).not.toContain('one-time-value');
    expect(first.execution.request).toMatchObject({
      mode: 'existing',
      techContactUserId: 'contact',
      baseUrl: `https://${r.input.tenantId}.apps.kaiyancn.com`,
    });
    for (const field of ['adminPhone', 'tenantName', 'grantCredits', 'members', 'manifest'])
      expect(first.execution.request).not.toHaveProperty(field);
    expect(await systems.listInstallationsForTenant(r.input.tenantId)).toHaveLength(1);
  });
  it.each(['active', 'tenantDisabled', 'userDisabled', 'userTenant'] as const)(
    '在任何业务写入前拒绝非法身份：%s',
    async (field) => {
      const r = rig();
      if (field === 'userTenant') r.state.userTenant = 'another-tenant';
      else r.state[field] = field.endsWith('Disabled');
      await expect(r.service.start(r.input, PLATFORM_ADMIN)).rejects.toThrow();
      expect(await systems.listInstallationsForTenant(r.input.tenantId)).toEqual([]);
      expect(r.issue).not.toHaveBeenCalled();
      const rows = await pool.query(`SELECT 1 FROM ${store.executionsTable} WHERE tenant_id=$1`, [
        r.input.tenantId,
      ]);
      expect(rows.rowCount).toBe(0);
    },
  );
  it('拒绝不存在的组织、其他组织联系人、旧配置版本和旧发布摘要', async () => {
    const r = rig();
    for (const patch of [
      { tenantId: 'unknown' },
      { techContactUserId: 'other' },
      { expectedSettingsVersion: 0 },
      { expectedDigest: '0'.repeat(64) },
    ])
      await expect(r.service.start({ ...r.input, ...patch }, PLATFORM_ADMIN)).rejects.toThrow();
    expect(r.issue).not.toHaveBeenCalled();
  });
  it('已有实例不能换联系人或更换地址重复接入；选择列表返回已有实例', async () => {
    const r = rig();
    await r.service.start(r.input, PLATFORM_ADMIN);
    await expect(
      r.service.start(
        {
          ...r.input,
          deployment: {
            baseUrl: 'https://different.apps.kaiyancn.com',
            origin: 'https://different.apps.kaiyancn.com',
          },
        },
        PLATFORM_ADMIN,
      ),
    ).rejects.toThrow('参数已变化');
    const options = await r.service.organizationOptions(TEST_SYSTEM, r.input.tenantId);
    expect(options).not.toHaveProperty('eligible');
    expect(options.members).toEqual([{ userId: 'contact', name: '已有管理员', isAdmin: true }]);
    expect(options.installation?.status).toBe('pending');
    expect(r.issue).toHaveBeenCalledTimes(1);
  });
  it('凭据、DNS、ready、成员授权依次检查；完成后保留审计和交付状态', async () => {
    const r = rig();
    const initial = await r.service.start(r.input, PLATFORM_ADMIN);
    const resume = () => r.service.resume(initial.execution.executionId, PLATFORM_ADMIN);
    expect((await resume()).execution.lastErrorCode).toBe('credential_ack_required');
    r.state.acked = true;
    expect((await resume()).execution.lastErrorCode).toBe('domain_verification_required');
    r.state.dns = true;
    expect((await resume()).execution.lastErrorCode).toBe('ready_required');
    r.state.ready = true;
    expect((await resume()).execution.lastErrorCode).toBe('assignment_required');
    expect(r.options.runSmoke).not.toHaveBeenCalled();
    r.state.assigned = true;
    const done = await resume();
    expect(done.execution.status).toBe('completed');
    expect(done.execution.result.adminUserId).toBe('contact');
    expect((await store.getDelivery(initial.execution.installationId))?.checklist).toMatchObject({
      assignmentConfigured: true,
      diagnosticPassed: true,
    });
    expect(r.issue).toHaveBeenCalledTimes(1);
  });
  it.each(['active', 'tenantDisabled', 'userDisabled'] as const)(
    '恢复执行仍重新检查组织和联系人状态：%s', async (field) => {
      const r = rig();
      const initial = await r.service.start(r.input, PLATFORM_ADMIN);
      r.state[field] = field.endsWith('Disabled');
      await expect(r.service.resume(initial.execution.executionId, PLATFORM_ADMIN)).rejects.toThrow();
      expect(r.issue).toHaveBeenCalledTimes(1);
      expect(r.options.runSmoke).not.toHaveBeenCalled();
      expect((await store.get(initial.execution.executionId))?.status).toBe('waiting_external');
    },
  );
  it('配置 CAS 冲突不覆盖原值，非法地址占位符拒绝', async () => {
    await expect(
      settings.save(TEST_SYSTEM, { baseUrl: '', origin: '' }, 0, 'actor'),
    ).rejects.toThrow('配置已变化');
    expect((await settings.get(TEST_SYSTEM)).version).toBe(1);
    expect(() =>
      validateConnectionSettings(
        {
          baseUrl: 'https://{other}.apps.kaiyancn.com',
          origin: 'https://{other}.apps.kaiyancn.com',
        },
        config,
      ),
    ).toThrow();
    expect(() =>
      validateConnectionSettings({ baseUrl: 'https://org.apps.kaiyancn.com', origin: '' }, config),
    ).toThrow();
  });
  it('真实 HTTP：平台可读取和接入；普通成员、组织管理员不能访问平台入口；未知字段拒绝', async () => {
    const r = rig();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user =
        req.header('x-test-role') === 'member'
          ? MEMBER
          : req.header('x-test-role') === 'org'
            ? ORG_ADMIN
            : PLATFORM_ADMIN;
      next();
    });
    app.use(
      createKyAppExistingOnboardRouter({
        ...r.options,
        audit: audit as never,
        management: new KyAppManagementQueries(pool, systems, prefix),
      }),
    );
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    for (const role of ['member', 'org']) {
      const response = await fetch(`${base}/systems/${TEST_SYSTEM}/connection-options`, {
        headers: { 'x-test-role': role },
      });
      expect(response.status).toBe(403);
      expect(
        (
          await fetch(`${base}/onboard-existing`, {
            method: 'POST',
            headers: { 'x-test-role': role, 'Content-Type': 'application/json' },
            body: JSON.stringify(r.input),
          })
        ).status,
      ).toBe(403);
    }
    const read = await fetch(`${base}/systems/${TEST_SYSTEM}/connection-options`);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await read.json()).organizations[0].id).toBe(r.input.tenantId);
    const send = (body: unknown) =>
      fetch(`${base}/onboard-existing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await send({ ...r.input, grantCredits: 100 })).status).toBe(400);
    const organization = await fetch(`${base}/systems/${TEST_SYSTEM}/connection-options/${r.input.tenantId}`);
    expect(organization.status).toBe(200);
    expect(await organization.json()).not.toHaveProperty('eligible');
    const created = await send(r.input);
    expect(created.status).toBe(202);
    const body = await created.json();
    expect(body.execution.request.mode).toBe('existing');
    expect(created.headers.get('cache-control')).toBe('no-store');
  });
});

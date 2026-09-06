/**
 * WP2a 平台端点 × 鉴权矩阵 + 发布门禁端到端用例（规范 §3.2、§8.1）。
 *
 * 路由、鉴权、门禁判定、状态机都是生产代码；只有存储与出站是内存替身
 * （`kyapp/__tests__/harness.ts`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MEMBER,
  ORG_ADMIN,
  OTHER_TENANT_ADMIN,
  PLATFORM_ADMIN,
  TEST_IID,
  TEST_ORIGIN,
  TEST_SYSTEM,
  TEST_TENANT,
  buildManifest,
  createKyAppTestRig,
  json,
  seedPublishedInstallation,
  type KyAppTestRig,
} from '../kyapp/__tests__/harness.js';

const BASE = '/api/app-contract/v1';
const rigs: KyAppTestRig[] = [];

async function rig(options: Parameters<typeof createKyAppTestRig>[0] = {}): Promise<KyAppTestRig> {
  const created = await createKyAppTestRig(options);
  rigs.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((item) => item.close()));
});

describe('kyApp 平台端点鉴权矩阵', () => {
  it('平台管理端点对匿名 / 普通成员 / 组织管理员一律 403 或 401', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    const cases: Array<[string, RequestInit]> = [
      [`${BASE}/systems`, { method: 'GET' }],
      [
        `${BASE}/systems/${TEST_SYSTEM}/versions`,
        json('POST', { name: 'x', manifest: buildManifest() }),
      ],
      [`${BASE}/installations`, json('POST', {})],
      [`${BASE}/installations/${TEST_IID}/verify-domain`, json('POST', {})],
      [`${BASE}/installations/${TEST_IID}/credentials`, json('POST', {})],
      [
        `${BASE}/installations/${TEST_IID}/registered-digest`,
        json('POST', { digest: 'a'.repeat(64) }),
      ],
      [`${BASE}/keys/rotate`, json('POST', {})],
      [`${BASE}/keys/revoke`, json('POST', { kid: 'ky-20260906-abcdef01' })],
    ];
    for (const identity of [null, MEMBER, ORG_ADMIN]) {
      harness.setUser(identity);
      for (const [path, init] of cases) {
        const response = await harness.request(path, init);
        expect([401, 403], `${path} @ ${identity?.username ?? 'anonymous'}`).toContain(
          response.status,
        );
      }
    }
  });

  it('组织管理员可以停用/启用本组织实例，但不能操作别的组织，也不能删除', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);

    harness.setUser(ORG_ADMIN);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'))).status,
    ).toBe(200);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/enable`, json('POST'))).status,
    ).toBe(200);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/delete`, json('POST'))).status,
    ).toBe(403);

    harness.setUser(OTHER_TENANT_ADMIN);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'))).status,
    ).toBe(403);

    harness.setUser(MEMBER);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'))).status,
    ).toBe(403);

    harness.setUser(null);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'))).status,
    ).toBe(401);
  });

  it('运行状态对组织管理员开放、对普通成员关闭', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    harness.setUser(ORG_ADMIN);
    expect((await harness.request(`${BASE}/installations/${TEST_IID}/runtime`)).status).toBe(200);
    harness.setUser(MEMBER);
    expect((await harness.request(`${BASE}/installations/${TEST_IID}/runtime`)).status).toBe(403);
  });

  it('错误体是附录 D 形态且不出现「上游」字样', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    const response = await harness.request(
      `${BASE}/installations/not-exist/verify-domain`,
      json('POST'),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: Record<string, unknown> };
    expect(body.ok).toBe(false);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId', 'retryable']);
    expect(String(body.error.message)).not.toContain('上游');
  });
});

describe('发布门禁端到端', () => {
  it('同 digest 幂等；触发复核 → publish 409 → 复核人≠发布者 → publish 200', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    const upload = json('POST', { name: '演示 ERP', manifest: buildManifest() });

    const first = await harness.request(`${BASE}/systems/${TEST_SYSTEM}/versions`, upload);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      created: boolean;
      version: { digest: string; reviewStatus: string };
      definition: { version: number };
      gate: { reviewRequired: boolean; reasons: string[] };
    };
    expect(firstBody.created).toBe(true);
    expect(firstBody.gate.reviewRequired).toBe(true);
    expect(firstBody.version.reviewStatus).toBe('pending');

    // 同 digest 重复上传：幂等，不新建版本。
    const again = await harness.request(`${BASE}/systems/${TEST_SYSTEM}/versions`, upload);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);

    const digest = firstBody.version.digest;
    const expectedVersion = firstBody.definition.version;

    // 未复核就发布 → 409 review_required。
    const blocked = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${digest}/publish`,
      json('POST', { expectedVersion }),
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { error: { code: string }; reasons: string[] };
    expect(blockedBody.error.code).toBe('review_required');
    expect(blockedBody.reasons.length).toBeGreaterThan(0);

    // 复核人 = 发布者（上传者）→ 拒绝。
    const selfReview = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${digest}/review`,
      json('POST'),
    );
    expect(selfReview.status).toBe(409);

    // 换一位平台管理员复核 → 通过。
    harness.setUser({ ...PLATFORM_ADMIN, sub: 'u_platform_2', username: 'platform2' });
    const review = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${digest}/review`,
      json('POST'),
    );
    expect(review.status).toBe(200);

    const published = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${digest}/publish`,
      json('POST', { expectedVersion }),
    );
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as {
      definition: { status: string; publishedDigest: string };
      gate: { toolRegistrationDryRun: { status: string } };
    };
    expect(publishedBody.definition.status).toBe('published');
    expect(publishedBody.definition.publishedDigest).toBe(digest);
    // dry-run 钩子未配置 → skipped（不是通过）。
    expect(publishedBody.gate.toolRegistrationDryRun.status).toBe('skipped');
  });

  it('配置了 dry-run 钩子时结果记 passed；钩子失败则拒绝发布', async () => {
    const dryRun = vi.fn(async () => undefined);
    const harness = await rig({ toolRegistrationDryRun: dryRun });
    harness.setUser(PLATFORM_ADMIN);
    const seeded = await seedPublishedInstallation(harness);
    // 无语义变化的重复发布：门禁不触发复核，直接走 dry-run。
    const response = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${seeded.digest}/publish`,
      json('POST', { expectedVersion: 2 }),
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { gate: { toolRegistrationDryRun: { status: string } } }).gate
        .toolRegistrationDryRun.status,
    ).toBe('passed');
    expect(dryRun).toHaveBeenCalledTimes(1);
  });

  it('retired 是终态：不能再登记版本，也不能再发布', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    const seeded = await seedPublishedInstallation(harness);
    const retire = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/status`,
      json('POST', { status: 'retired', expectedVersion: 2 }),
    );
    expect(retire.status).toBe(200);
    const upload = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions`,
      json('POST', { name: '演示 ERP', manifest: buildManifest({ description: '改了' }) }),
    );
    expect(upload.status).toBe(409);
    const publish = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions/${seeded.digest}/publish`,
      json('POST', { expectedVersion: 3 }),
    );
    expect(publish.status).toBe(409);
  });

  it('manifest 不合契约时 400，且不落库', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    const response = await harness.request(
      `${BASE}/systems/${TEST_SYSTEM}/versions`,
      json('POST', {
        name: 'x',
        manifest: buildManifest({ pathPrefixes: { user: ['/ky/'], admin: [] } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await harness.systems.getDefinition(TEST_SYSTEM)).toBeNull();
  });
});

describe('registeredDigest CAS 与实例状态机', () => {
  it('CAS 需要最近一次 ready 的 digest 与目标一致', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    const seeded = await seedPublishedInstallation(harness);

    // 没有 ready 上报 → 409。
    const noReady = await harness.request(
      `${BASE}/installations/${TEST_IID}/registered-digest`,
      json('POST', { digest: seeded.digest, expectedRegisteredDigest: null }),
    );
    expect(noReady.status).toBe(409);

    // ready 上报了别的 digest → 409。
    await harness.runtimeStore.recordReady({
      installationId: TEST_IID,
      status: 'ok',
      manifestDigest: 'b'.repeat(64),
    });
    const mismatch = await harness.request(
      `${BASE}/installations/${TEST_IID}/registered-digest`,
      json('POST', { digest: seeded.digest, expectedRegisteredDigest: null }),
    );
    expect(mismatch.status).toBe(409);

    // ready 与目标一致 → 200。
    await harness.runtimeStore.recordReady({
      installationId: TEST_IID,
      status: 'ok',
      manifestDigest: seeded.digest,
    });
    const ok = await harness.request(
      `${BASE}/installations/${TEST_IID}/registered-digest`,
      json('POST', { digest: seeded.digest, expectedRegisteredDigest: null }),
    );
    expect(ok.status).toBe(200);

    // 乐观锁：再用 null 作为期望值 → 409。
    const stale = await harness.request(
      `${BASE}/installations/${TEST_IID}/registered-digest`,
      json('POST', { digest: seeded.digest, expectedRegisteredDigest: null }),
    );
    expect(stale.status).toBe(409);
  });

  it('enable/disable/delete 推进 stateVersion 并入 outbox；deleted 是吸收终态', async () => {
    const harness = await rig();
    harness.setUser(PLATFORM_ADMIN);
    await seedPublishedInstallation(harness);
    const before = (await harness.systems.getInstallation(TEST_IID))!.stateVersion;

    await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'));
    await harness.request(`${BASE}/installations/${TEST_IID}/enable`, json('POST'));
    await harness.request(`${BASE}/installations/${TEST_IID}/delete`, json('POST'));

    const after = (await harness.systems.getInstallation(TEST_IID))!;
    expect(after.status).toBe('deleted');
    expect(after.stateVersion).toBe(before + 3);

    const events = [...harness.eventStore.events.values()].sort(
      (a, b) => a.stateVersion - b.stateVersion,
    );
    expect(events.map((item) => item.type)).toEqual([
      'installation.disabled',
      'installation.enabled',
      'installation.deleted',
    ]);
    expect(events.map((item) => item.stateVersion)).toEqual([before + 1, before + 2, before + 3]);

    // 吸收终态：再操作一律 409。
    const again = await harness.request(`${BASE}/installations/${TEST_IID}/enable`, json('POST'));
    expect(again.status).toBe(409);
  });

  it('建实例要求系统已发布、origin 合法、技术联系人是本组织成员', async () => {
    const harness = await rig({
      getMembership: async (_tenantId, userId) =>
        userId === 'u_tech' ? { persona: 'member', status: 'active' } : null,
    });
    harness.setUser(PLATFORM_ADMIN);
    const body = {
      installationId: 'tsi_new_01',
      tenantId: TEST_TENANT,
      systemId: TEST_SYSTEM,
      baseUrl: TEST_ORIGIN,
      origin: TEST_ORIGIN,
      techContactUserId: 'u_tech',
    };
    // 系统还不存在 → 404。
    expect((await harness.request(`${BASE}/installations`, json('POST', body))).status).toBe(404);

    await seedPublishedInstallation(harness);
    // 非本组织成员 → 409。
    const badContact = await harness.request(
      `${BASE}/installations`,
      json('POST', { ...body, techContactUserId: 'u_stranger' }),
    );
    expect(badContact.status).toBe(409);

    const created = await harness.request(`${BASE}/installations`, json('POST', body));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      installation: { status: string };
      domainVerification: { recordName: string; recordValue: string };
    };
    expect(createdBody.installation.status).toBe('pending');
    expect(createdBody.domainVerification.recordName).toBe('_ky-app-verify.erp.example.com');
    expect(createdBody.domainVerification.recordValue.length).toBeGreaterThanOrEqual(22);
  });

  it('域名归属验证读 DNS TXT，未命中即 409', async () => {
    let token = '';
    const harness = await rig({
      resolveTxt: async () => [[token]],
      getMembership: async () => ({ persona: 'member', status: 'active' }),
    });
    harness.setUser(PLATFORM_ADMIN);
    await seedPublishedInstallation(harness);
    const created = (await (
      await harness.request(
        `${BASE}/installations`,
        json('POST', {
          installationId: 'tsi_dns_01',
          tenantId: TEST_TENANT,
          systemId: TEST_SYSTEM,
          baseUrl: TEST_ORIGIN,
          origin: TEST_ORIGIN,
          techContactUserId: 'u_tech',
        }),
      )
    ).json()) as { domainVerification: { recordValue: string } };

    token = 'wrong-token-value-that-is-long';
    expect(
      (await harness.request(`${BASE}/installations/tsi_dns_01/verify-domain`, json('POST')))
        .status,
    ).toBe(409);

    token = created.domainVerification.recordValue;
    const ok = await harness.request(
      `${BASE}/installations/tsi_dns_01/verify-domain`,
      json('POST'),
    );
    expect(ok.status).toBe(200);
    expect((await harness.systems.getInstallation('tsi_dns_01'))!.domainVerifiedAt).not.toBeNull();
  });
});

describe('/api/systems/mine', () => {
  it('只返回本组织、enabled 且分配命中的实例', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);

    harness.setUser(MEMBER);
    const visible = (await (await harness.request('/api/systems/mine')).json()) as {
      installations: Array<{ installationId: string; name: string; state: string }>;
    };
    expect(visible.installations).toEqual([
      {
        installationId: TEST_IID,
        systemId: TEST_SYSTEM,
        name: '演示 ERP',
        icon: null,
        origin: TEST_ORIGIN,
        state: 'enabled',
      },
    ]);

    // 别的组织看不到。
    harness.setUser(OTHER_TENANT_ADMIN);
    expect(
      ((await (await harness.request('/api/systems/mine')).json()) as { installations: unknown[] })
        .installations,
    ).toEqual([]);

    // 停用后看不到。
    harness.setUser(PLATFORM_ADMIN);
    await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'));
    harness.setUser(MEMBER);
    expect(
      ((await (await harness.request('/api/systems/mine')).json()) as { installations: unknown[] })
        .installations,
    ).toEqual([]);

    harness.setUser(null);
    expect((await harness.request('/api/systems/mine')).status).toBe(401);
  });

  it('分配未命中即不可见', async () => {
    const harness = await rig({ visibleInstallationIds: [] });
    await seedPublishedInstallation(harness);
    harness.setUser(MEMBER);
    expect(
      ((await (await harness.request('/api/systems/mine')).json()) as { installations: unknown[] })
        .installations,
    ).toEqual([]);
  });
});

describe('JWKS 端点', () => {
  it('公开返回 EC P-256 公钥，带 max-age=600', async () => {
    const harness = await rig();
    harness.setUser(null);
    const response = await harness.request('/.well-known/ky-app-jwks.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=600');
    const body = (await response.json()) as { keys: Array<Record<string, string>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig' });
    expect(body.keys[0]!.d).toBeUndefined();
  });
});

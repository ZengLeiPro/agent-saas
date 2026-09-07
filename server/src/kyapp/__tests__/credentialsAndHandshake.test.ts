/**
 * WP2a 服务凭据生命周期与壳握手（规范 §3.2、§3.6、§5.4、§8.4）。
 */
import { describe, expect, it, afterEach } from 'vitest';

import { issueAttestation, deriveInstallationKeys } from '@kaiyan/ky-app-server';

import {
  KY_APP_CREDENTIAL_ACK_WINDOW_MS,
  KY_APP_CREDENTIAL_LIFETIME_MS,
  KY_APP_CREDENTIAL_ALERT_WINDOW_MS,
} from '../installations/credentials.js';
import {
  MEMBER,
  PLATFORM_ADMIN,
  TEST_IID,
  TEST_ORIGIN,
  createKyAppTestRig,
  json,
  seedPublishedInstallation,
  type KyAppTestRig,
} from './harness.js';

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

/** 领取一套凭据；返回明文（只有测试会碰它）。 */
async function claimCredential(harness: KyAppTestRig): Promise<{
  serviceCredential: string;
  installationKey: string;
  keyVersion: string;
  ticket: string;
}> {
  harness.setUser(PLATFORM_ADMIN);
  const issued = (await (
    await harness.request(`${BASE}/installations/${TEST_IID}/credentials`, json('POST'))
  ).json()) as { credential: { ticket: string } };
  harness.setUser({ ...MEMBER, sub: 'u_tech', username: 'tech' });
  const claimed = (await (
    await harness.request(
      `${BASE}/installations/${TEST_IID}/credentials/claim/${issued.credential.ticket}`,
    )
  ).json()) as {
    credential: { serviceCredential: string; installationKey: string; keyVersion: string };
  };
  return { ...claimed.credential, ticket: issued.credential.ticket };
}

describe('服务凭据一次性领取与确认', () => {
  it('签发响应不含明文；领取只成功一次；非技术联系人不能领', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    harness.setUser(PLATFORM_ADMIN);
    const issued = await harness.request(
      `${BASE}/installations/${TEST_IID}/credentials`,
      json('POST'),
    );
    expect(issued.status).toBe(201);
    const issuedText = await issued.text();
    expect(issuedText).not.toContain('serviceCredential');
    const ticket = (JSON.parse(issuedText) as { credential: { ticket: string } }).credential.ticket;
    // 票据 ≥192 bit → base64url 至少 32 字符。
    expect(ticket.length).toBeGreaterThanOrEqual(32);

    // 非技术联系人 → 403。
    harness.setUser(MEMBER);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/credentials/claim/${ticket}`))
        .status,
    ).toBe(403);

    harness.setUser({ ...MEMBER, sub: 'u_tech' });
    const first = await harness.request(
      `${BASE}/installations/${TEST_IID}/credentials/claim/${ticket}`,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as { credential: { serviceCredential: string } };
    expect(body.credential.serviceCredential.length).toBeGreaterThanOrEqual(40);

    // 第二次领取 → 409，且 vault 里的明文已被墓碑替换。
    const second = await harness.request(
      `${BASE}/installations/${TEST_IID}/credentials/claim/${ticket}`,
    );
    expect(second.status).toBe(409);
  });

  it('credential-ack 用服务凭据 Bearer 自鉴权；24 小时后失效', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    const claimed = await claimCredential(harness);

    // 匿名 + 无 Bearer → 401。
    harness.setUser(null);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/credential-ack`, json('POST')))
        .status,
    ).toBe(401);

    // 错凭据 → 401。
    expect(
      (
        await harness.request(`${BASE}/installations/${TEST_IID}/credential-ack`, {
          method: 'POST',
          headers: { authorization: 'Bearer not-a-real-credential' },
        })
      ).status,
    ).toBe(401);

    const ok = await harness.request(`${BASE}/installations/${TEST_IID}/credential-ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claimed.serviceCredential}` },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe('active');
  });

  it('24 小时未确认即失效，且失效后不能再确认', async () => {
    let clock = Date.parse('2026-09-06T00:00:00.000Z');
    const harness = await rig({ now: () => clock });
    await seedPublishedInstallation(harness);
    const claimed = await claimCredential(harness);

    clock += KY_APP_CREDENTIAL_ACK_WINDOW_MS + 1000;
    expect(await harness.credentials.expireStale()).toBe(1);
    const response = await harness.request(`${BASE}/installations/${TEST_IID}/credential-ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claimed.serviceCredential}` },
    });
    expect(response.status).toBe(401);
  });

  it('双凭据重叠轮换：新凭据确认后旧凭据被撤销', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    const older = await claimCredential(harness);
    await harness.credentials.acknowledge(older.serviceCredential);
    const newer = await claimCredential(harness);

    // 重叠期：旧凭据仍可用。
    await expect(
      harness.credentials.authenticate(older.serviceCredential, 'snapshot'),
    ).resolves.not.toBeNull();

    await harness.credentials.acknowledge(newer.serviceCredential);
    await expect(
      harness.credentials.authenticate(older.serviceCredential, 'snapshot'),
    ).resolves.toBeNull();
    await expect(
      harness.credentials.authenticate(newer.serviceCredential, 'snapshot'),
    ).resolves.not.toBeNull();
  });

  it('到期前 14 天进告警项', async () => {
    let clock = Date.parse('2026-09-06T00:00:00.000Z');
    const harness = await rig({ now: () => clock });
    await seedPublishedInstallation(harness);
    const claimed = await claimCredential(harness);
    await harness.credentials.acknowledge(claimed.serviceCredential);

    expect(await harness.credentials.listRotationDue(TEST_IID)).toHaveLength(0);
    clock += KY_APP_CREDENTIAL_LIFETIME_MS - KY_APP_CREDENTIAL_ALERT_WINDOW_MS + 1000;
    expect(await harness.credentials.listRotationDue(TEST_IID)).toHaveLength(1);
  });

  it('安装密钥轮换：previous 在 24 小时窗口内仍可验安装证明', async () => {
    const harness = await rig();
    await seedPublishedInstallation(harness);
    const first = await claimCredential(harness);
    const second = await claimCredential(harness);
    expect(second.keyVersion).not.toBe(first.keyVersion);

    const acceptable = await harness.credentials.listAcceptableInstallationKeys(TEST_IID);
    expect(acceptable.map((item) => item.keyVersion).sort()).toEqual(
      [first.keyVersion, second.keyVersion].sort(),
    );
  });
});

describe('壳握手', () => {
  async function handshakeSetup(options: Parameters<typeof createKyAppTestRig>[0] = {}): Promise<{
    harness: KyAppTestRig;
    keyVersion: string;
    installationKey: string;
  }> {
    const harness = await rig(options);
    await seedPublishedInstallation(harness);
    const claimed = await claimCredential(harness);
    return {
      harness,
      keyVersion: claimed.keyVersion,
      installationKey: claimed.installationKey,
    };
  }

  async function attest(input: {
    keyVersion: string;
    installationKey: string;
    nonce: string;
    origin?: string;
  }): Promise<string> {
    return issueAttestation({
      nonce: input.nonce,
      dig: 'c'.repeat(64),
      origin: input.origin ?? TEST_ORIGIN,
      iid: TEST_IID,
      audience: 'https://agent.kaiyan.net',
      keys: deriveInstallationKeys(
        new Uint8Array(Buffer.from(input.installationKey, 'base64')),
        input.keyVersion,
      ),
    });
  }

  it('nonce 绑定壳会话+用户+iid；attest 通过后签 user SAT', async () => {
    const { harness, keyVersion, installationKey } = await handshakeSetup();
    harness.setUser(MEMBER);
    const nonceResponse = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/nonce`,
      json('POST'),
    );
    expect(nonceResponse.status).toBe(200);
    const { nonce } = (await nonceResponse.json()) as { nonce: string };
    expect(nonce.length).toBeGreaterThanOrEqual(22);

    const attestation = await attest({ keyVersion, installationKey, nonce });
    const verified = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce, attestation }),
    );
    expect(verified.status).toBe(200);
    const body = (await verified.json()) as {
      token: string;
      tokenExp: number;
      user: { id: string; isTenantAdmin: boolean };
      installationId: string;
      contractVersion: number;
    };
    expect(body.user.id).toBe(MEMBER.sub);
    expect(body.user.isTenantAdmin).toBe(false);
    expect(body.installationId).toBe(TEST_IID);
    expect(body.contractVersion).toBe(1);
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('同 nonce 同 attestation 重复提交返回缓存结果；换一份 attestation 被拒', async () => {
    const { harness, keyVersion, installationKey } = await handshakeSetup();
    harness.setUser(MEMBER);
    const { nonce } = (await (
      await harness.request(`${BASE}/installations/${TEST_IID}/handshake/nonce`, json('POST'))
    ).json()) as { nonce: string };
    const attestation = await attest({ keyVersion, installationKey, nonce });

    const first = (await (
      await harness.request(
        `${BASE}/installations/${TEST_IID}/handshake/verify`,
        json('POST', { nonce, attestation }),
      )
    ).json()) as { token: string };
    const again = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce, attestation }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { token: string }).token).toBe(first.token);

    // 同 nonce、不同 attestation → 拒。
    const other = await attest({ keyVersion, installationKey, nonce, origin: TEST_ORIGIN });
    const rejected = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce, attestation: other }),
    );
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('conflict');
    expect(harness.handshake.failureCount(TEST_IID)).toBeGreaterThan(0);
  });

  it('缓存重放仍校验成员授权、用户和会话；撤权后不能续期', async () => {
    const visible = [TEST_IID];
    const { harness, keyVersion, installationKey } = await handshakeSetup({ visibleInstallationIds: visible });
    harness.setUser(MEMBER);
    const { nonce } = await (await harness.request(`${BASE}/installations/${TEST_IID}/handshake/nonce`, json('POST'))).json();
    const attestation = await attest({ keyVersion, installationKey, nonce });
    const verify = () => harness.request(`${BASE}/installations/${TEST_IID}/handshake/verify`, json('POST', { nonce, attestation }));
    expect((await verify()).status).toBe(200);
    for (const identity of [{ ...MEMBER, sub: 'another-member' }, { ...MEMBER, jti: 'another-session' }]) {
      harness.setUser(identity);
      expect((await verify()).status).toBe(403);
    }
    harness.setUser(MEMBER);
    visible.length = 0;
    expect((await verify()).status).toBe(403);
    expect((await harness.request(`${BASE}/installations/${TEST_IID}/token`, json('POST'))).status).toBe(403);
  });

  it('别的用户拿到 nonce 也换不到令牌（绑定校验）', async () => {
    const { harness, keyVersion, installationKey } = await handshakeSetup();
    harness.setUser(MEMBER);
    const { nonce } = (await (
      await harness.request(`${BASE}/installations/${TEST_IID}/handshake/nonce`, json('POST'))
    ).json()) as { nonce: string };
    const attestation = await attest({ keyVersion, installationKey, nonce });

    harness.setUser({ ...MEMBER, sub: 'u_thief', username: 'thief', jti: 'sess-thief' });
    const stolen = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce, attestation }),
    );
    expect(stolen.status).toBe(409);
  });

  it('origin 与登记不符的安装证明被拒；未知 nonce 被拒', async () => {
    const { harness, keyVersion, installationKey } = await handshakeSetup();
    harness.setUser(MEMBER);
    const { nonce } = (await (
      await harness.request(`${BASE}/installations/${TEST_IID}/handshake/nonce`, json('POST'))
    ).json()) as { nonce: string };
    const wrongOrigin = await attest({
      keyVersion,
      installationKey,
      nonce,
      origin: 'https://evil.example.com',
    });
    const rejected = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce, attestation: wrongOrigin }),
    );
    expect(rejected.status).toBe(409);

    const unknownNonce = await harness.request(
      `${BASE}/installations/${TEST_IID}/handshake/verify`,
      json('POST', { nonce: 'x'.repeat(43), attestation: wrongOrigin }),
    );
    expect(unknownNonce.status).toBe(409);
  });

  it('停用实例后 nonce 与续期都拒绝', async () => {
    const { harness } = await handshakeSetup();
    harness.setUser(PLATFORM_ADMIN);
    await harness.request(`${BASE}/installations/${TEST_IID}/disable`, json('POST'));
    harness.setUser(MEMBER);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/handshake/nonce`, json('POST')))
        .status,
    ).toBe(403);
    expect(
      (await harness.request(`${BASE}/installations/${TEST_IID}/token`, json('POST'))).status,
    ).toBe(403);
  });

  it('token 续期不需要 attest，但仍走全部前置', async () => {
    const { harness } = await handshakeSetup();
    harness.setUser(MEMBER);
    const response = await harness.request(`${BASE}/installations/${TEST_IID}/token`, json('POST'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; tokenExp: number };
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.tokenExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

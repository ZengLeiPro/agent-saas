/**
 * §9.3-13：平台事件。`stateVersion` 乱序、`disabled` 后 SAT 403 而 events 仍可达、
 * `enabled` 恢复、`deleted` 吸收、`jwks.probe` 回 `verifiedKid`、`eventId` 幂等。
 *
 * **本章在执行顺序上排在最后**：`installation.deleted` 是吸收终态，跑完之后
 * 被测实例不再接受业务请求。
 */
import { assert, expectErrorCode, expectStatus, newRequestId } from '../harness/http.js';
import { fixtureUsers } from './fixtures.js';
import type { DoctorContext } from './context.js';

interface Ack {
  eventId?: string;
  ack?: boolean;
  stateVersion?: number;
  verifiedKid?: string;
}

function baseEvent(
  ctx: DoctorContext,
  type: string,
  stateVersion: number,
  payload?: unknown,
): Record<string, unknown> {
  return {
    eventId: newRequestId('evt'),
    iid: ctx.shell.app.installationId,
    stateVersion,
    type,
    occurredAt: new Date().toISOString(),
    ...(payload === undefined ? {} : { payload }),
  };
}

export async function chapter13(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(13);
  const users = fixtureUsers(ctx);

  await reporter.check('stateVersion 跳号 → 409 state_gap', async () => {
    const result = await ctx.sendEvent(
      baseEvent(ctx, 'installation.disabled', ctx.currentStateVersion() + 2),
    );
    expectStatus(result, 409, '跳号事件');
    expectErrorCode(result, 'state_gap', '跳号事件');
  });

  await reporter.check('stateVersion 更小 → 忽略但仍 ack', async () => {
    const result = await ctx.sendEvent(
      baseEvent(ctx, 'installation.disabled', Math.max(0, ctx.currentStateVersion() - 1)),
    );
    expectStatus(result, 200, '旧事件');
    const ack = result.json as Ack;
    assert(ack.ack === true, '旧事件也必须 ack');
    assert(
      ack.stateVersion === ctx.currentStateVersion(),
      `ack 的 stateVersion 应为本地当前值 ${String(ctx.currentStateVersion())}，实际 ${String(ack.stateVersion)}`,
    );
    const me = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.member.sub });
    expectStatus(me, 200, '旧的 disabled 事件不得真的停用实例');
  });

  await reporter.check('eventId 幂等：同一事件重投返回同一 ack', async () => {
    const event = baseEvent(ctx, 'jwks.rotated', ctx.currentStateVersion(), {
      newKid: await ctx.shell.signer.addKey('k-doctor-2'),
    });
    const first = await ctx.sendEvent(event);
    expectStatus(first, 200, '首次投递');
    const second = await ctx.sendEvent(event);
    expectStatus(second, 200, '重复投递');
    // 只比内容，不比键序：ack 走过一次 JSON 往返后字段顺序可能不同。
    const normalize = (value: unknown): string =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      );
    assert(
      normalize(first.json) === normalize(second.json),
      `两次 ack 不一致：${JSON.stringify(first.json)} vs ${JSON.stringify(second.json)}`,
    );
  });

  await reporter.check('jwks.rotated 后用新 kid 签的 SAT 可验签', async () => {
    const token = await ctx.shell.signer.signWith(
      'k-doctor-2',
      {
        ...(await import('../mockShell/sat.js')).userClaims(ctx.shell.app, {
          sub: users.member.sub,
        }),
      },
      { kid: 'k-doctor-2' },
    );
    const result = await ctx.call({ path: '/ky/v1/me', token });
    expectStatus(result, 200, '新 kid 签发的 SAT');
  });

  await reporter.check('jwks.probe 回 verifiedKid', async () => {
    const { platformClaims } = await import('../mockShell/sat.js');
    const probeSat = await ctx.shell.signer.sign(
      platformClaims(ctx.shell.app, { rid: 'req_probe' }),
    );
    const result = await ctx.sendEvent(
      baseEvent(ctx, 'jwks.probe', ctx.currentStateVersion(), {
        kid: ctx.shell.signer.kid,
        probeSat,
      }),
    );
    expectStatus(result, 200, 'jwks.probe');
    const ack = result.json as Ack;
    assert(
      ack.verifiedKid === ctx.shell.signer.kid,
      `期望 verifiedKid=${ctx.shell.signer.kid}，实际 ${String(ack.verifiedKid)}`,
    );
  });

  await reporter.check('jwks.revoke 后该 kid 立即失效', async () => {
    const { userClaims } = await import('../mockShell/sat.js');
    const token = await ctx.shell.signer.signWith(
      'k-doctor-2',
      userClaims(ctx.shell.app, { sub: users.member.sub }),
      { kid: 'k-doctor-2' },
    );
    ctx.shell.signer.removeKey('k-doctor-2');
    const revoke = await ctx.sendEvent(
      baseEvent(ctx, 'jwks.revoke', ctx.currentStateVersion(), { kid: 'k-doctor-2' }),
    );
    expectStatus(revoke, 200, 'jwks.revoke');
    const result = await ctx.call({ path: '/ky/v1/me', token });
    expectStatus(result, 401, '已撤销 kid 签发的 SAT');
  });

  await reporter.check('installation.disabled → SAT 403，而 events / health 仍可达', async () => {
    const disabled = await ctx.sendEvent(
      baseEvent(ctx, 'installation.disabled', ctx.nextStateVersion()),
    );
    expectStatus(disabled, 200, 'installation.disabled');
    const me = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.member.sub });
    expectStatus(me, 403, 'disabled 状态下的 /me');
    expectErrorCode(me, 'installation_disabled', 'disabled 状态下的 /me');
    expectStatus(
      await ctx.call({ path: '/ky/v1/health/live' }),
      200,
      'disabled 状态下的 health/live',
    );
    const probe = await ctx.sendEvent(
      baseEvent(ctx, 'jwks.probe', ctx.currentStateVersion(), {
        kid: ctx.shell.signer.kid,
        probeSat: await ctx.shell.signer.sign(
          (await import('../mockShell/sat.js')).platformClaims(ctx.shell.app, {
            rid: 'req_probe2',
          }),
        ),
      }),
    );
    expectStatus(probe, 200, 'disabled 状态下 events 仍可达');
  });

  await reporter.check('installation.enabled → 恢复', async () => {
    const enabled = await ctx.sendEvent(
      baseEvent(ctx, 'installation.enabled', ctx.nextStateVersion()),
    );
    expectStatus(enabled, 200, 'installation.enabled');
    const me = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.member.sub });
    expectStatus(me, 200, '恢复后的 /me');
  });

  await reporter.check('installation.deleted 是吸收终态（此后 enabled 也不再恢复）', async () => {
    const deleted = await ctx.sendEvent(
      baseEvent(ctx, 'installation.deleted', ctx.nextStateVersion()),
    );
    expectStatus(deleted, 200, 'installation.deleted');
    const me = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.member.sub });
    expectStatus(me, 403, 'deleted 状态下的 /me');
    const enabled = await ctx.sendEvent(
      baseEvent(ctx, 'installation.enabled', ctx.nextStateVersion()),
    );
    expectStatus(enabled, 200, 'deleted 之后的 enabled 事件仍应 ack');
    const after = await ctx.callAsUser({ path: '/ky/v1/me' }, { sub: users.member.sub });
    expectStatus(after, 403, 'deleted 之后不得被 enabled 复活');
  });
}

/**
 * 握手状态机与 §5.4 消息路由器。
 *
 * 用假定时器跑真实控制器；只有 `api` / `audit` / 回调是替身。
 * 覆盖总控点名的几条：init 字段白名单、重复 `(type,id)` 重放、`init.ack` 重发、
 * 401 单飞、`navId` 回声、伪造 `event.source`、`link.open` 拒绝集。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppHostController, type AppHostInstallation, type AppHostSnapshot } from './controller';
import { AppHostApiError, type HandshakeGrant } from './handshakeApi';

const ORIGIN = 'https://crm.example.com';
const NONCE = 'n'.repeat(32);

const installation: AppHostInstallation = {
  installationId: 'inst-1',
  name: '客户管理',
  origin: ORIGIN,
  externalLinkHosts: ['docs.example.com'],
};

function grant(overrides: Partial<HandshakeGrant> = {}): HandshakeGrant {
  return {
    token: 'sat-1',
    tokenExp: Math.floor(Date.now() / 1000) + 300,
    user: { id: 'u1', displayName: '张三', isTenantAdmin: false },
    installationId: 'inst-1',
    contractVersion: 1,
    ...overrides,
  };
}

interface Rig {
  controller: AppHostController;
  posted: Array<{ envelope: Record<string, unknown>; targetOrigin: string }>;
  audits: Array<{ event: string; reason?: string }>;
  snapshots: AppHostSnapshot[];
  agentOpens: Array<{ text: string; installationId: string }>;
  paths: Array<{ path: string; mode: string }>;
  frameWindow: Window;
  api: {
    nonce: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
  logouts: number;
  permissionReloads: number;
  confirmAnswer: { value: boolean };
  opened: string[];
  send: (data: unknown, from?: { origin?: string; source?: unknown }) => Promise<unknown>;
  lastOf: (type: string) => Record<string, unknown> | undefined;
  countOf: (type: string) => number;
}

function createRig(): Rig {
  const posted: Rig['posted'] = [];
  const frameWindow = {
    postMessage: (envelope: unknown, targetOrigin: string) => {
      posted.push({ envelope: envelope as Record<string, unknown>, targetOrigin });
    },
  } as unknown as Window;

  const audits: Rig['audits'] = [];
  const snapshots: AppHostSnapshot[] = [];
  const agentOpens: Rig['agentOpens'] = [];
  const paths: Rig['paths'] = [];
  const opened: string[] = [];
  const confirmAnswer = { value: true };
  const counters = { logouts: 0, permissionReloads: 0 };

  const api = {
    nonce: vi.fn(async () => ({ nonce: NONCE, expiresAt: '' })),
    verify: vi.fn(async () => grant()),
    refresh: vi.fn(async () => grant({ token: 'sat-2' })),
  };

  const controller = new AppHostController({
    api: api as never,
    audit: (input) =>
      audits.push({ event: input.event, ...(input.reason ? { reason: input.reason } : {}) }),
    onChange: (snapshot) => snapshots.push(snapshot),
    onAgentOpen: (request) => agentOpens.push(request),
    onLogout: () => {
      counters.logouts += 1;
    },
    onAppPath: (path, mode) => paths.push({ path, mode }),
    onPermissionMaybeChanged: () => {
      counters.permissionReloads += 1;
    },
    theme: () => 'light',
    confirm: () => confirmAnswer.value,
    openLink: (url) => {
      opened.push(url);
      return true;
    },
  });
  controller.setFrameWindow(frameWindow);

  const rig: Rig = {
    controller,
    posted,
    audits,
    snapshots,
    agentOpens,
    paths,
    frameWindow,
    api,
    get logouts() {
      return counters.logouts;
    },
    get permissionReloads() {
      return counters.permissionReloads;
    },
    confirmAnswer,
    opened,
    send: (data, from = {}) =>
      controller.handleMessage({
        origin: from.origin ?? ORIGIN,
        source: 'source' in from ? (from.source as MessageEventSource) : frameWindow,
        data,
      } as Pick<MessageEvent, 'origin' | 'source' | 'data'>),
    lastOf: (type) => [...posted].reverse().find((item) => item.envelope.type === type)?.envelope,
    countOf: (type) => posted.filter((item) => item.envelope.type === type).length,
  } as Rig;
  return rig;
}

function readyEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ns: 'ky',
    v: 1,
    type: 'ready',
    id: 'ready-1',
    payload: {
      contractVersion: 1,
      path: '/',
      installationId: 'inst-1',
      attestation: 'jwt',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('握手 loading → attesting → ready → init → active', () => {
  it('走通全程并按顺序推进 phase', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    expect(rig.controller.state.phase).toBe('attesting');
    expect(rig.controller.state.frameSrc).toContain('ky_nonce=');

    await rig.send(readyEnvelope());
    expect(rig.api.verify).toHaveBeenCalledTimes(1);
    expect(rig.controller.state.phase).toBe('init');

    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    expect(rig.controller.state.phase).toBe('active');
    expect(rig.controller.state.failure).toBeNull();
    expect(rig.snapshots.map((item) => item.phase)).toEqual([
      'loading',
      'attesting',
      'ready',
      'init',
      'active',
    ]);
  });

  it('init 载荷是字段白名单，绝不含任何壳会话令牌字段', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    const init = rig.lastOf('init');
    const payload = init?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'contractVersion',
      'installationId',
      'locale',
      'theme',
      'token',
      'tokenExp',
      'user',
    ]);
    expect(Object.keys(payload.user as object).sort()).toEqual([
      'displayName',
      'id',
      'isTenantAdmin',
    ]);
    // 壳会话 JWT / 刷新令牌 / authEpoch / 租户 id 一律不下发
    const serialized = JSON.stringify(payload);
    for (const leak of [
      'authEpoch',
      'generation',
      'tenantId',
      'refreshToken',
      'jti',
      'sessionId',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    expect(payload.token).toBe('sat-1');
  });

  it('targetOrigin 精确为安装实例 origin，绝不是 *', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    expect(rig.posted.every((item) => item.targetOrigin === ORIGIN)).toBe(true);
  });

  it('ready.path 作 canonical，用 replaceState 洗 URL（§5.2）', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/orders');
    await rig.send(readyEnvelope({ path: '/orders/list' }));
    expect(rig.paths).toEqual([{ path: '/orders/list', mode: 'replace' }]);
  });
});

describe('握手失败（§6.6 第一行）', () => {
  it('拿不到 nonce → 客户面文案 + 可重试 + 记安全事件', async () => {
    const rig = createRig();
    rig.api.nonce.mockRejectedValueOnce(new AppHostApiError('boom', 503, 'unavailable'));
    await rig.controller.mount(installation, '/');
    expect(rig.controller.state.failure?.message).toBe('《客户管理》暂时无法加载，已通知技术支持');
    expect(rig.controller.state.failure?.retryable).toBe(true);
    expect(rig.audits).toContainEqual({ event: 'handshake_failed', reason: 'nonce_unavailable' });
  });

  it('证明校验被拒 → 同一条文案，记 attestation_failed', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    rig.api.verify.mockRejectedValueOnce(new AppHostApiError('bad', 401, 'unauthorized'));
    await rig.send(readyEnvelope());
    expect(rig.controller.state.failure?.kind).toBe('handshake_failed');
    expect(rig.audits).toContainEqual({ event: 'attestation_failed', reason: 'verify_rejected' });
  });

  it('10 s 内没有合法 ready → 握手失败', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await vi.advanceTimersByTimeAsync(9999);
    expect(rig.controller.state.failure).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(rig.controller.state.failure?.kind).toBe('handshake_failed');
    expect(rig.audits).toContainEqual({ event: 'handshake_failed', reason: 'ready_timeout' });
  });

  it('contractVersion 不是 1 → 「系统版本不兼容」，不重试', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope({ contractVersion: 2 }));
    expect(rig.controller.state.failure).toEqual({
      kind: 'contract_version_mismatch',
      message: '系统版本不兼容',
      retryable: false,
    });
    expect(rig.api.verify).not.toHaveBeenCalled();
  });
});

describe('§5.4-4 init.ack 重发', () => {
  it('5 s 没等到 init.ack 就重发，最多 3 次，之后判失败', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    expect(rig.countOf('init')).toBe(1);
    for (const expected of [2, 3, 4]) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(rig.countOf('init')).toBe(expected);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(rig.countOf('init')).toBe(4);
    expect(rig.controller.state.failure?.kind).toBe('handshake_failed');
  });

  it('收到 init.ack 后不再重发', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.countOf('init')).toBe(1);
  });
});

describe('§5.3 重复 (type,id) 重放缓存', () => {
  it('重复 ready：只校验一次证明，但 init 每次都重放', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send(readyEnvelope());
    await rig.send(readyEnvelope());
    expect(rig.api.verify).toHaveBeenCalledTimes(1);
    expect(rig.countOf('init')).toBe(3);
    const payloads = rig.posted
      .filter((item) => item.envelope.type === 'init')
      .map((item) => JSON.stringify(item.envelope));
    expect(new Set(payloads).size).toBe(1);
  });

  it('重复 token.request：只续期一次，token.refresh 每次都重放', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    const request = { ns: 'ky', v: 1, type: 'token.request', id: 'tok-1' };
    await rig.send(request);
    await rig.send(request);
    expect(rig.api.refresh).toHaveBeenCalledTimes(1);
    expect(rig.countOf('token.refresh')).toBe(2);
  });

  it('不同 id 的 token.request 各自续期（不是无脑去重）', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'token.request', id: 'tok-1' });
    await rig.send({ ns: 'ky', v: 1, type: 'token.request', id: 'tok-2' });
    expect(rig.api.refresh).toHaveBeenCalledTimes(2);
  });

  it('401 单飞：并发的两条不同 id 只打一次续期端点', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    let release: (value: HandshakeGrant) => void = () => {};
    rig.api.refresh.mockImplementation(
      () =>
        new Promise<HandshakeGrant>((resolve) => {
          release = resolve;
        }),
    );
    const a = rig.send({ ns: 'ky', v: 1, type: 'token.request', id: 'tok-a' });
    const b = rig.send({ ns: 'ky', v: 1, type: 'token.request', id: 'tok-b' });
    expect(rig.api.refresh).toHaveBeenCalledTimes(1);
    release(grant({ token: 'sat-9' }));
    await Promise.all([a, b]);
    expect(rig.countOf('token.refresh')).toBe(2);
  });
});

describe('token.refresh.error 的四个 reason', () => {
  it.each([
    [401, null, 'session_expired', 'session_expired'],
    [403, 'installation_disabled', 'installation_disabled', 'unavailable'],
    [403, 'forbidden', 'user_disabled', 'user_disabled'],
    [503, 'unavailable', 'temporary', null],
  ])('HTTP %s/%s → reason %s', async (status, code, reason, failureKind) => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    rig.api.refresh.mockRejectedValueOnce(
      new AppHostApiError('x', status as number, code as string | null),
    );
    await rig.send({ ns: 'ky', v: 1, type: 'token.request', id: 'tok-x' });
    expect((rig.lastOf('token.refresh.error')?.payload as { reason: string }).reason).toBe(reason);
    // temporary 交给子端退避重试，壳不把用户从页面上踢走
    expect(rig.controller.state.failure?.kind ?? null).toBe(failureKind);
  });
});

describe('来源伪造', () => {
  it('同源伪造帧（origin 合法、source 不是本 iframe）被拒并记安全事件', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    const reason = await rig.send(readyEnvelope(), { source: { name: 'forger' } });
    expect(reason).toBe('source');
    expect(rig.api.verify).not.toHaveBeenCalled();
    expect(rig.audits).toContainEqual({ event: 'message_rejected', reason: 'source' });
  });

  it('别的 origin 发来的消息被拒并记安全事件', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    const reason = await rig.send(readyEnvelope(), { origin: 'https://evil.example.com' });
    expect(reason).toBe('origin');
    expect(rig.audits).toContainEqual({ event: 'message_rejected', reason: 'origin' });
  });

  it('噪音消息（别的库的 postMessage）不记安全事件', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send({ type: 'webpackHotUpdate' });
    expect(rig.audits.filter((item) => item.event === 'message_rejected')).toHaveLength(0);
  });
});

describe('路由（§5.2）', () => {
  async function active(): Promise<Rig> {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    return rig;
  }

  it('route.changed 无 navId = 用户在应用内导航 → pushState', async () => {
    const rig = await active();
    rig.paths.length = 0;
    await rig.send({ ns: 'ky', v: 1, type: 'route.changed', payload: { path: '/orders/9' } });
    expect(rig.paths).toEqual([{ path: '/orders/9', mode: 'push' }]);
  });

  it('route.changed 带壳自己的 navId = 回声 → replaceState（历史里不多一条）', async () => {
    const rig = await active();
    void rig.controller.navigate('/orders/9');
    const navId = rig.lastOf('route.navigate')?.navId as string;
    rig.paths.length = 0;
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'route.changed',
      navId,
      payload: { path: '/orders/9' },
    });
    expect(rig.paths).toEqual([{ path: '/orders/9', mode: 'replace' }]);
  });

  it('route.navigate 5 s 没有 route.result 就超时收场', async () => {
    const rig = await active();
    const pending = rig.controller.navigate('/orders');
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
  });

  it('route.result{forbidden} → 刷新可见系统 + 回首页 + 「权限已更新」', async () => {
    const rig = await active();
    const pending = rig.controller.navigate('/admin');
    const id = rig.lastOf('route.navigate')?.id as string;
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'route.result',
      id,
      payload: { ok: false, reason: 'forbidden' },
    });
    expect(await pending).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(rig.permissionReloads).toBe(1);
    expect(rig.paths.at(-1)).toEqual({ path: '/', mode: 'replace' });
    expect(rig.controller.state.notice?.message).toBe('权限已更新');
  });

  it('route.result{not_found} → 回首页 + 「链接无效，已返回首页」', async () => {
    const rig = await active();
    void rig.controller.navigate('/nope');
    const id = rig.lastOf('route.navigate')?.id as string;
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'route.result',
      id,
      payload: { ok: false, reason: 'not_found' },
    });
    expect(rig.controller.state.notice?.message).toBe('链接无效，已返回首页');
  });

  it('perm.changed 触发重拉可见系统', async () => {
    const rig = await active();
    await rig.send({ ns: 'ky', v: 1, type: 'perm.changed', payload: { permVersion: '2' } });
    expect(rig.permissionReloads).toBe(1);
  });

  it('同一实例换应用内路径不重新握手（§5.5 保留页面）', async () => {
    const rig = await active();
    await rig.controller.mount(installation, '/orders');
    expect(rig.api.nonce).toHaveBeenCalledTimes(1);
    expect(rig.lastOf('route.navigate')?.payload).toEqual({ path: '/orders' });
  });
});

describe('agent.open / link.open / toast / logout.request', () => {
  async function active(): Promise<Rig> {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    return rig;
  }

  it('agent.open 只预填、带「来自《系统名》」标注、落审计', async () => {
    const rig = await active();
    await rig.send({ ns: 'ky', v: 1, type: 'agent.open', payload: { prompt: '催一下这单' } });
    expect(rig.agentOpens).toEqual([
      { text: '来自《客户管理》\n催一下这单', installationId: 'inst-1' },
    ]);
    expect(rig.audits).toContainEqual({ event: 'agent_open' });
    // 绝不自动发送：控制器只把文本交给总线，没有任何「发送」出口
    expect(rig.countOf('agent.send')).toBe(0);
  });

  it('link.open 白名单内 + 用户确认 → 打开并回 ok:true', async () => {
    const rig = await active();
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'l1',
      payload: { url: 'https://docs.example.com/a' },
    });
    expect(rig.opened).toEqual(['https://docs.example.com/a']);
    expect(rig.lastOf('link.result')?.payload).toEqual({ ok: true });
  });

  it('用户在确认框点取消 → ok:false，不打开', async () => {
    const rig = await active();
    rig.confirmAnswer.value = false;
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'l2',
      payload: { url: 'https://docs.example.com/a' },
    });
    expect(rig.opened).toEqual([]);
    expect(rig.lastOf('link.result')?.payload).toEqual({ ok: false });
  });

  it.each([
    ['http://docs.example.com/', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['https://evil.example.com/', 'not_allowlisted'],
    ['https://127.0.0.1/', 'ip_host'],
    ['https://u:p@docs.example.com/', 'userinfo'],
  ])('link.open 拒绝 %s 并记 link_blocked(%s)', async (url, reason) => {
    const rig = await active();
    await rig.send({ ns: 'ky', v: 1, type: 'link.open', id: 'l3', payload: { url } });
    expect(rig.opened).toEqual([]);
    expect(rig.lastOf('link.result')?.payload).toEqual({ ok: false });
    expect(rig.audits).toContainEqual({ event: 'link_blocked', reason });
  });

  it('重复 link.open 只弹一次确认框，link.result 重放', async () => {
    const rig = await active();
    let confirms = 0;
    const message = {
      ns: 'ky',
      v: 1,
      type: 'link.open',
      id: 'l4',
      payload: { url: 'https://docs.example.com/a' },
    };
    // 用 opened 的长度间接观察副作用次数
    await rig.send(message);
    confirms = rig.opened.length;
    await rig.send(message);
    expect(rig.opened).toHaveLength(confirms);
    expect(rig.countOf('link.result')).toBe(2);
  });

  it('toast 进壳内条幅，纯文本截断到 200 字', async () => {
    const rig = await active();
    await rig.send({
      ns: 'ky',
      v: 1,
      type: 'toast',
      payload: { level: 'warning', message: 'x'.repeat(500) },
    });
    expect(rig.controller.state.notice?.level).toBe('warning');
    expect(rig.controller.state.notice?.message).toHaveLength(200);
  });

  it('logout.request → 壳登出、清空状态', async () => {
    const rig = await active();
    await rig.send({ ns: 'ky', v: 1, type: 'logout.request' });
    expect(rig.logouts).toBe(1);
    expect(rig.controller.state.phase).toBe('idle');
    expect(rig.controller.state.frameSrc).toBeNull();
    expect(rig.controller.state.failure?.kind).toBe('logged_out');
  });
});

describe('theme / visibility（壳 → 子）', () => {
  async function active(): Promise<Rig> {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    return rig;
  }

  it('theme.changed 直接下发', async () => {
    const rig = await active();
    rig.controller.setTheme('dark');
    expect(rig.lastOf('theme.changed')?.payload).toEqual({ theme: 'dark' });
  });

  it('回前台时令牌还够用就不续期', async () => {
    const rig = await active();
    await rig.controller.setVisibility(true);
    expect(rig.api.refresh).not.toHaveBeenCalled();
    expect(rig.lastOf('visibility')?.payload).toEqual({ visible: true });
  });

  it('回前台时令牌快过期 → 先续期再发 visibility（§5.4）', async () => {
    const rig = createRig();
    await rig.controller.mount(installation, '/');
    rig.api.verify.mockResolvedValueOnce(grant({ tokenExp: Math.floor(Date.now() / 1000) + 5 }));
    await rig.send(readyEnvelope());
    await rig.send({ ns: 'ky', v: 1, type: 'init.ack' });
    await rig.controller.setVisibility(true);
    expect(rig.api.refresh).toHaveBeenCalledTimes(1);
    const order = rig.posted.map((item) => item.envelope.type);
    expect(order.indexOf('token.refresh')).toBeLessThan(order.indexOf('visibility'));
  });
});

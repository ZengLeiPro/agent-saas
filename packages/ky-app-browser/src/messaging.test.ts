/** §5.3 来源校验与丢弃计数；§5.4 其余子→壳 API（openAgent / openLink / toast / logout）。 */
import { describe, expect, it, vi } from 'vitest';

import { SHELL_ORIGIN, bootstrap, shellMessage } from './__tests__/harness.js';
import { checkExternalLink } from './links.js';

const ALLOWED_HOSTS = ['docs.kaiyan.net', 'Status.Example.COM'];

describe('入站来源校验', () => {
  it('伪造 event.origin 一律丢弃并计数', async () => {
    const onTheme = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTheme });
    shell.send(shellMessage('theme.changed', { theme: 'dark' }), {
      origin: 'https://evil.example.com',
    });
    await clock.advance(0);

    expect(onTheme).not.toHaveBeenCalled();
    expect(app.getState().counters.droppedOrigin).toBe(1);
    app.destroy();
  });

  it('伪造 event.source（不是 window.parent）一律丢弃并计数', async () => {
    const onTheme = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTheme });
    shell.send(shellMessage('theme.changed', { theme: 'dark' }), { source: { fake: true } });
    await clock.advance(0);

    expect(onTheme).not.toHaveBeenCalled();
    expect(app.getState().counters.droppedSource).toBe(1);
    expect(app.getState().counters.droppedOrigin).toBe(0);
    app.destroy();
  });

  it('ns:ky-experimental（context.set）一律丢弃并单独计数', async () => {
    const { app, shell, clock } = await bootstrap();
    shell.send(
      shellMessage('context.set', { entity: { type: 'order' } }, { ns: 'ky-experimental' }),
    );
    await clock.advance(0);
    expect(app.getState().counters.droppedExperimental).toBe(1);
    app.destroy();
  });

  it('ns / v / type 不符分别丢弃并计数', async () => {
    const { app, shell, clock } = await bootstrap();
    shell.send(shellMessage('theme.changed', { theme: 'dark' }, { ns: 'other' }));
    shell.send(shellMessage('theme.changed', { theme: 'dark' }, { v: 2 }));
    shell.send(shellMessage('unknown.type', {}));
    shell.send('不是对象');
    await clock.advance(0);

    const counters = app.getState().counters;
    expect(counters.droppedNamespace).toBe(2);
    expect(counters.droppedVersion).toBe(1);
    expect(counters.droppedType).toBe(1);
    app.destroy();
  });

  it('destroy() 之后不再收消息，也没有残留定时器', async () => {
    const onTheme = vi.fn();
    const { app, shell, clock } = await bootstrap({ onTheme });
    app.destroy();

    expect(shell.listeners.size).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    shell.send(shellMessage('theme.changed', { theme: 'dark' }));
    await clock.advance(600_000);
    expect(onTheme).not.toHaveBeenCalled();
  });
});

describe('openLink 本地校验', () => {
  it('纯函数层：非 https / userinfo / IP / 非白名单一律拒绝', () => {
    expect(checkExternalLink('http://docs.kaiyan.net/a', ALLOWED_HOSTS).reason).toBe('not_https');
    expect(checkExternalLink('javascript:alert(1)', ALLOWED_HOSTS).reason).toBe('not_https');
    expect(checkExternalLink('data:text/html,x', ALLOWED_HOSTS).reason).toBe('not_https');
    expect(checkExternalLink('https://user:pass@docs.kaiyan.net/a', ALLOWED_HOSTS).reason).toBe(
      'userinfo',
    );
    expect(checkExternalLink('https://192.168.1.1/a', ALLOWED_HOSTS).reason).toBe('ip_host');
    expect(checkExternalLink('https://[::1]/a', ALLOWED_HOSTS).reason).toBe('ip_host');
    expect(checkExternalLink('https://2130706433/a', ALLOWED_HOSTS).reason).toBe('ip_host');
    expect(checkExternalLink('https://other.example.com/a', ALLOWED_HOSTS).reason).toBe(
      'not_allowlisted',
    );
    expect(checkExternalLink('不是 URL', ALLOWED_HOSTS).reason).toBe('invalid_url');
    // 白名单大小写不敏感。
    expect(checkExternalLink('https://status.example.com/x', ALLOWED_HOSTS).ok).toBe(true);
  });

  it('不合规的外链直接本地拒绝，一条消息都不发', async () => {
    const { app, shell } = await bootstrap({ externalLinkHosts: ALLOWED_HOSTS });

    await expect(app.openLink('http://docs.kaiyan.net/a')).resolves.toEqual({
      ok: false,
      reason: 'not_https',
    });
    await expect(app.openLink('https://evil.example.com/a')).resolves.toEqual({
      ok: false,
      reason: 'not_allowlisted',
    });
    await expect(app.openLink('https://10.0.0.1/a')).resolves.toEqual({
      ok: false,
      reason: 'ip_host',
    });

    expect(shell.ofType('link.open')).toHaveLength(0);
    expect(app.getState().counters.blockedLinks).toBe(3);
    app.destroy();
  });

  it('白名单内的 https 外链发 link.open 并等 link.result', async () => {
    const { app, shell, clock } = await bootstrap({ externalLinkHosts: ALLOWED_HOSTS });
    const pending = app.openLink('https://docs.kaiyan.net/guide');
    await clock.advance(0);

    const request = shell.lastOfType('link.open');
    expect(request?.payload).toEqual({ url: 'https://docs.kaiyan.net/guide' });
    shell.send(shellMessage('link.result', { ok: true }, { id: request?.id }));
    await clock.advance(0);
    await expect(pending).resolves.toEqual({ ok: true });
    app.destroy();
  });

  it('壳 5 s 不回 link.result 时超时返回', async () => {
    const { app, shell, clock } = await bootstrap({ externalLinkHosts: ALLOWED_HOSTS });
    const pending = app.openLink('https://docs.kaiyan.net/guide');
    await clock.advance(5000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(shell.ofType('link.open')).toHaveLength(1);
    app.destroy();
  });
});

describe('其余子→壳 API', () => {
  it('openAgent：prompt 超 500 字截断并告警，context.entity 必填三字段', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, shell } = await bootstrap();

    app.openAgent({
      prompt: '订'.repeat(600),
      context: { entity: { type: 'order', id: 'o1', label: '订单 o1' }, summary: '待发货' },
    });
    const payload = shell.lastOfType('agent.open')?.payload as { prompt: string };
    expect([...payload.prompt]).toHaveLength(500);
    expect(warn).toHaveBeenCalled();
    expect(shell.lastOfType('agent.open')?.payload).toMatchObject({
      context: { entity: { type: 'order', id: 'o1', label: '订单 o1' }, summary: '待发货' },
    });

    expect(() => app.openAgent({ context: { entity: { type: 'order' } as never } })).toThrow(
      /entity/u,
    );
    warn.mockRestore();
    app.destroy();
  });

  it('openAgent 剔除控制字符（纯文本）', async () => {
    const { app, shell } = await bootstrap();
    app.openAgent({ prompt: '订单\u0000\u001b异常\n换行' });
    expect(shell.lastOfType('agent.open')?.payload).toEqual({ prompt: '订单异常\n换行' });
    app.destroy();
  });

  it('toast：level 受限、文案 ≤ 200 字', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, shell } = await bootstrap();

    app.toast({ level: 'warning', message: '提'.repeat(300) });
    const payload = shell.lastOfType('toast')?.payload as { level: string; message: string };
    expect(payload.level).toBe('warning');
    expect([...payload.message]).toHaveLength(200);
    expect(() => app.toast({ level: 'fatal' as never, message: 'x' })).toThrow(/level/u);
    warn.mockRestore();
    app.destroy();
  });

  it('requestLogout / permChanged 直接发消息', async () => {
    const { app, shell } = await bootstrap();
    app.requestLogout();
    app.permChanged('v9');

    expect(shell.ofType('logout.request')).toHaveLength(1);
    expect(shell.lastOfType('perm.changed')?.payload).toEqual({ permVersion: 'v9' });
    expect(shell.posted.every((item) => item.targetOrigin === SHELL_ORIGIN)).toBe(true);
    app.destroy();
  });

  it('getState() 给出诊断快照', async () => {
    const { app } = await bootstrap();
    const state = app.getState();
    expect(state.phase).toBe('active');
    expect(state.mode).toBe('embedded');
    expect(state.installationId).toBe('iid_demo');
    expect(state.shellOrigin).toBe(SHELL_ORIGIN);
    expect(typeof state.tokenExp).toBe('number');
    expect(state.counters).toMatchObject({
      droppedOrigin: 0,
      droppedSource: 0,
      replayedReplies: 0,
      refreshes: 0,
    });
    app.destroy();
  });
});

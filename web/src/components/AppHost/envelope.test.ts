/**
 * §5.3 来源校验。跨源 iframe 是全仓首例，这些判定是壳唯一的信任边界，
 * 每一条都要有独立用例（含「只比 origin 会被同源伪造帧打穿」的反证）。
 */
import { describe, expect, it } from 'vitest';

import {
  SECURITY_RELEVANT_REJECTIONS,
  buildOutgoingEnvelope,
  classifyIncomingMessage,
} from './envelope';

const APP_ORIGIN = 'https://t1-crm.apps.example.com';
const frameWindow = { name: 'child' } as unknown as Window;
const forgerWindow = { name: 'forger' } as unknown as Window;

function event(overrides: Partial<{ origin: string; source: unknown; data: unknown }> = {}) {
  return {
    origin: APP_ORIGIN,
    source: frameWindow,
    data: { ns: 'ky', v: 1, type: 'ready', id: 'r1', payload: {} },
    ...overrides,
  } as Pick<MessageEvent, 'origin' | 'source' | 'data'>;
}

const gate = { appOrigin: APP_ORIGIN, frameWindow };

describe('classifyIncomingMessage', () => {
  it('放行合法信封', () => {
    const verdict = classifyIncomingMessage(event(), gate);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.envelope.type).toBe('ready');
  });

  it('origin 精确比对：子域、端口、协议差一点都拒', () => {
    for (const origin of [
      'https://evil.example.com',
      'https://t1-crm.apps.example.com.evil.com',
      'http://t1-crm.apps.example.com',
      'https://t1-crm.apps.example.com:8443',
      'null',
    ]) {
      expect(classifyIncomingMessage(event({ origin }), gate)).toEqual({
        ok: false,
        reason: 'origin',
      });
    }
  });

  it('source 必须是当前 iframe 的 contentWindow（同源伪造帧打不穿）', () => {
    // shell.html:416-419 的 forger：同源的另一个 iframe，origin 完全合法
    expect(classifyIncomingMessage(event({ source: forgerWindow }), gate)).toEqual({
      ok: false,
      reason: 'source',
    });
    expect(classifyIncomingMessage(event({ source: null }), gate)).toEqual({
      ok: false,
      reason: 'source',
    });
  });

  it('iframe 未挂载 / origin 未知时一律拒绝，不「先收再说」', () => {
    expect(classifyIncomingMessage(event(), { appOrigin: null, frameWindow })).toEqual({
      ok: false,
      reason: 'origin',
    });
    expect(classifyIncomingMessage(event(), { appOrigin: APP_ORIGIN, frameWindow: null })).toEqual({
      ok: false,
      reason: 'source',
    });
  });

  it('信封形状不对逐条给出原因', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'shape'],
      ['ready', 'shape'],
      [{ ns: 'other', v: 1, type: 'ready' }, 'namespace'],
      [{ ns: 'ky-experimental', v: 1, type: 'ready' }, 'namespace'],
      [{ ns: 'ky', v: 2, type: 'ready' }, 'version'],
      [{ ns: 'ky', v: '1', type: 'ready' }, 'version'],
      [{ ns: 'ky', v: 1 }, 'shape'],
      [{ ns: 'ky', v: 1, type: 'ready', id: 7 }, 'shape'],
      [{ ns: 'ky', v: 1, type: 'ready', navId: {} }, 'shape'],
    ];
    for (const [data, reason] of cases) {
      expect(classifyIncomingMessage(event({ data }), gate)).toEqual({ ok: false, reason });
    }
  });

  it('只接受「子到壳」方向的 type，壳自己的 type 回流一律丢弃', () => {
    for (const type of ['init', 'token.refresh', 'route.navigate', 'theme.changed', 'nope']) {
      expect(classifyIncomingMessage(event({ data: { ns: 'ky', v: 1, type } }), gate)).toEqual({
        ok: false,
        reason: 'type',
      });
    }
    for (const type of ['ready', 'init.ack', 'token.request', 'agent.open', 'logout.request']) {
      expect(classifyIncomingMessage(event({ data: { ns: 'ky', v: 1, type } }), gate).ok).toBe(
        true,
      );
    }
  });

  it('只有 origin / source 两类拒绝算安全事件', () => {
    expect([...SECURITY_RELEVANT_REJECTIONS]).toEqual(['origin', 'source']);
  });
});

describe('buildOutgoingEnvelope', () => {
  it('payload 为 undefined 时不写该键（与 shell.html:147-155 一致）', () => {
    expect(buildOutgoingEnvelope('init.ack')).toEqual({ ns: 'ky', v: 1, type: 'init.ack' });
    expect(Object.keys(buildOutgoingEnvelope('init.ack'))).not.toContain('payload');
  });

  it('id / navId 按需附上', () => {
    expect(
      buildOutgoingEnvelope('route.navigate', { path: '/a' }, { id: 'n1', navId: 'v1' }),
    ).toEqual({
      ns: 'ky',
      v: 1,
      type: 'route.navigate',
      id: 'n1',
      navId: 'v1',
      payload: { path: '/a' },
    });
  });
});

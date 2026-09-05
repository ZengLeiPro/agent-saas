/**
 * jsdom 下的测试装置：假时钟、假窗口（含 `parent`）、假 `fetch`、mock 壳。
 *
 * 不用真实浏览器（真实浏览器 e2e 属 Phase C）：两个「窗口」由手工对象模拟，
 * 入站消息通过 `send()` 直接投递给 SDK 注册的 `message` 监听器。
 */
import { createKyApp } from '../createKyApp.js';
import type { AnyEnvelope } from '../messenger.js';
import type {
  KyApp,
  KyAppOptions,
  KyMessageListener,
  KyTimerHandle,
  KyTimers,
  KyWindowLike,
} from '../types.js';

export interface TestClock {
  now: () => number;
  timers: KyTimers;
  /** 推进时钟并在每个到期回调前后冲刷微任务队列。 */
  advance: (ms: number) => Promise<void>;
  pendingCount: () => number;
}

interface ScheduledTask {
  id: number;
  due: number;
  fn: () => void;
}

export function createClock(startMs = 1_700_000_000_000): TestClock {
  let current = startMs;
  let seq = 0;
  const tasks: ScheduledTask[] = [];

  const timers: KyTimers = {
    setTimeout: (handler, delayMs) => {
      seq += 1;
      tasks.push({ id: seq, due: current + Math.max(0, delayMs), fn: handler });
      return seq;
    },
    clearTimeout: (handle: KyTimerHandle) => {
      const index = tasks.findIndex((task) => task.id === handle);
      if (index >= 0) tasks.splice(index, 1);
    },
  };

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  const advance = async (ms: number): Promise<void> => {
    const target = current + ms;
    await flush();
    for (;;) {
      let next: ScheduledTask | undefined;
      for (const task of tasks) {
        if (task.due > target) continue;
        if (
          next === undefined ||
          task.due < next.due ||
          (task.due === next.due && task.id < next.id)
        ) {
          next = task;
        }
      }
      if (next === undefined) break;
      tasks.splice(tasks.indexOf(next), 1);
      current = Math.max(current, next.due);
      next.fn();
      await flush();
    }
    current = target;
    await flush();
  };

  return { now: () => current, timers, advance, pendingCount: () => tasks.length };
}

export interface PostedMessage {
  envelope: AnyEnvelope;
  targetOrigin: string;
}

export interface HistoryCall {
  mode: 'push' | 'replace';
  url: string;
}

export interface TestWindow {
  win: KyWindowLike;
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  posted: PostedMessage[];
  history: HistoryCall[];
  listeners: Set<KyMessageListener>;
  /** 模拟壳发消息给子端。 */
  send: (data: unknown, options?: { origin?: string; source?: unknown }) => void;
  ofType: (type: string) => AnyEnvelope[];
  lastOfType: (type: string) => AnyEnvelope | undefined;
}

export const SHELL_ORIGIN = 'https://agent.kaiyan.net';
export const APP_ORIGIN = 'https://demo.apps.kaiyancn.com';

export function createTestWindow(options?: {
  href?: string;
  referrer?: string;
  shellOrigin?: string;
}): TestWindow {
  const posted: PostedMessage[] = [];
  const history: HistoryCall[] = [];
  const listeners = new Set<KyMessageListener>();
  const shellOrigin = options?.shellOrigin ?? SHELL_ORIGIN;
  const parent = {
    postMessage: (message: unknown, targetOrigin: string) => {
      posted.push({ envelope: message as AnyEnvelope, targetOrigin });
    },
  };
  const win: KyWindowLike = {
    location: {
      href: options?.href ?? `${APP_ORIGIN}/orders?ky=1&ky_iid=iid_demo&ky_nonce=nonce_demo`,
    },
    parent,
    document: { referrer: options?.referrer ?? `${shellOrigin}/apps/iid_demo/orders` },
    history: {
      pushState: (_data, _unused, url) => history.push({ mode: 'push', url: String(url) }),
      replaceState: (_data, _unused, url) => history.push({ mode: 'replace', url: String(url) }),
    },
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === 'message') listeners.delete(listener);
    },
  };

  const send = (data: unknown, sendOptions?: { origin?: string; source?: unknown }): void => {
    const event = {
      origin: sendOptions?.origin ?? shellOrigin,
      source: sendOptions !== undefined && 'source' in sendOptions ? sendOptions.source : parent,
      data,
    };
    for (const listener of [...listeners]) listener(event);
  };

  const ofType = (type: string): AnyEnvelope[] =>
    posted.filter((item) => item.envelope.type === type).map((item) => item.envelope);

  return {
    win,
    parent,
    posted,
    history,
    listeners,
    send,
    ofType,
    lastOfType: (type) => ofType(type).at(-1),
  };
}

/** 构造壳→子信封。 */
export function shellMessage(
  type: string,
  payload?: unknown,
  extra?: { id?: string; navId?: string; ns?: string; v?: number },
): Record<string, unknown> {
  return {
    ns: extra?.ns ?? 'ky',
    v: extra?.v ?? 1,
    type,
    ...(extra?.id === undefined ? {} : { id: extra.id }),
    ...(extra?.navId === undefined ? {} : { navId: extra.navId }),
    ...(payload === undefined ? {} : { payload }),
  };
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export interface FetchStubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: typeof fetch;
  calls: FetchCall[];
  /** 按顺序返回；用尽后重复最后一条。 */
  queue: FetchStubResponse[];
  /** 覆盖式路由：命中 URL 子串时返回指定响应。 */
  routes: Map<string, FetchStubResponse[]>;
}

export function createFetchStub(initial?: FetchStubResponse[]): FetchStub {
  const calls: FetchCall[] = [];
  const queue: FetchStubResponse[] = initial ?? [];
  const routes = new Map<string, FetchStubResponse[]>();

  const impl = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    for (const [fragment, responses] of routes) {
      if (!url.includes(fragment)) continue;
      const next = responses.length > 1 ? responses.shift() : responses[0];
      return Promise.resolve(makeResponse(next));
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(makeResponse(next));
  }) as unknown as typeof fetch;

  return { impl, calls, queue, routes };
}

export function makeResponse(spec?: FetchStubResponse): Response {
  const status = spec?.status ?? 200;
  const headers = spec?.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : headers[key];
      },
    },
    json: () => Promise.resolve(spec?.body ?? {}),
    text: () => Promise.resolve(JSON.stringify(spec?.body ?? {})),
  } as unknown as Response;
}

/** 默认 attest 响应。 */
export function attestResponse(attestation = 'attest.jwt.value'): FetchStubResponse {
  return { status: 200, body: { attestation } };
}

/** 生成 `init` 载荷；`tokenExp` 为秒级 epoch。 */
export function initPayload(nowMs: number, overrides?: Record<string, unknown>) {
  return {
    token: 'sat.token.v1',
    tokenExp: Math.floor(nowMs / 1000) + 300,
    user: { id: 'u_1', displayName: '张三', isTenantAdmin: false },
    theme: 'light',
    locale: 'zh-CN',
    installationId: 'iid_demo',
    contractVersion: 1,
    ...overrides,
  };
}

/** 一次性完成 attest → ready → init → active，返回可继续操作的上下文。 */
export interface Bootstrapped {
  app: KyApp;
  shell: TestWindow;
  clock: TestClock;
  fetchStub: FetchStub;
  /** 首条 ready 的 id。 */
  readyId: string;
  /** 壳回复某条需应答消息。 */
  reply: (type: string, payload: unknown, requestType: string) => void;
}

export async function bootstrap(
  overrides?: Partial<KyAppOptions> & {
    href?: string;
    nowMs?: number;
    init?: Record<string, unknown>;
  },
): Promise<Bootstrapped> {
  const clock = createClock(overrides?.nowMs);
  const shell = createTestWindow(
    overrides?.href === undefined ? undefined : { href: overrides.href },
  );
  const fetchStub = createFetchStub([attestResponse()]);
  fetchStub.routes.set('/ky/v1/attest', [attestResponse()]);
  const { href: _href, nowMs: _nowMs, init: _init, ...appOptions } = overrides ?? {};
  const app = createKyApp({
    window: shell.win,
    fetch: fetchStub.impl,
    timers: clock.timers,
    now: clock.now,
    ...appOptions,
  });
  await clock.advance(0);
  const readyId = String(shell.lastOfType('ready')?.id);
  shell.send(
    shellMessage('init', { ...initPayload(clock.now()), ...overrides?.init }, { id: readyId }),
  );
  await clock.advance(0);

  const reply = (type: string, payload: unknown, requestType: string): void => {
    const request = shell.lastOfType(requestType);
    shell.send(shellMessage(type, payload, { id: request?.id }));
  };

  return { app, shell, clock, fetchStub, readyId, reply };
}

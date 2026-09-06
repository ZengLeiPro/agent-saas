/**
 * 演示态的平台 API 桩（只在 `demo/vite.config.ts` 里替换 `@/lib/authFetch`）。
 *
 * 覆盖壳会打的全部端点：可见系统、握手三件套、壳事件审计、计费两件套。
 *
 * 场景与子端 origin 走 `window.__demo*` 全局（由截图脚本 `addInitScript` 注入），
 * **不能走 query** —— §5.2 会把壳 URL 的 query 当成应用内路径的一部分，
 * 用 `?scenario=` 会直接污染发给子端的 path。
 */
declare global {
  interface Window {
    __demoScenario?: string;
    __demoAppOrigin?: string;
    /** Phase C E2E 的 API 计划：只加延迟与失败注入，不改任何成功路径的形状。 */
    __demoApiPlan?: DemoApiPlan;
  }
}

/**
 * E2E 用的平台 API 计划（`page.addInitScript` 注入）。
 * 默认全空 —— 不注入时演示态行为与目视验收时逐字节一致。
 */
export interface DemoApiPlan {
  /** 让 `handshake/nonce` 慢下来（验「src 设置→init.ack ≤3 s」的口径起点）。 */
  nonceDelayMs?: number;
  /** 让 `handshake/verify` 慢下来（子端会在此期间按 1 s 重发 ready）。 */
  verifyDelayMs?: number;
  /** 让续期端点慢下来（验 401 单飞：并发 token.request 只打一次）。 */
  tokenDelayMs?: number;
  /** SAT 剩余寿命（秒），默认 300。 */
  tokenExpSeconds?: number;
  /** 续期端点直接失败，用于 §5.4 的四个 `token.refresh.error` reason。 */
  tokenError?: { status: number; code?: string };
}

function plan(): DemoApiPlan {
  return window.__demoApiPlan ?? {};
}

function delay(ms: number | undefined): Promise<void> {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
/**
 * 唯一标记串。`web/scripts/check-oss-dist.mjs` 断言生产产物里搜不到它 ——
 * 演示态一旦被误接进 `web/vite.config.ts` 的入口图，构建就会红。
 * 不要改这个字面量，也不要在生产源码里写它。
 */
export const DEMO_STUB_MARKER = 'ky-app-demo-stub-do-not-ship';

export type DemoScenario = 'ok' | 'disabled' | 'credits' | 'handshake-failed';

function scenario(): DemoScenario {
  const value = window.__demoScenario;
  if (value === 'disabled' || value === 'credits' || value === 'handshake-failed') return value;
  return 'ok';
}

function appOrigin(): string {
  return window.__demoAppOrigin ?? 'http://localhost:4181';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 演示用的可见安装实例。
 * `disabled` 场景下 CRM **仍然在列表里**，只是 `state: 'disabled'` ——
 * 规范 §5.5/§6.6 要求停用的系统标签保留在侧边栏并显示《系统名》+「暂不可用」，
 * 而不是整项消失（旧演示态把它从列表里删掉，截出来的图是规范违反）。
 */
function installations(): unknown[] {
  const crm = {
    installationId: 'tsi_crm_01',
    systemId: 'crm',
    name: '客户管理',
    icon: '📦',
    origin: appOrigin(),
    state: scenario() === 'disabled' ? 'disabled' : 'enabled',
    externalLinkHosts: ['docs.kaiyan.net'],
  };
  const wms = {
    installationId: 'tsi_wms_01',
    systemId: 'wms',
    name: '仓储管理',
    icon: '🚚',
    origin: appOrigin(),
    state: 'enabled',
    externalLinkHosts: [],
  };
  return [crm, wms];
}

const CALLS: string[] = [];
(window as unknown as { __demoCalls: string[] }).__demoCalls = CALLS;

/** 每次调用一行，带方法与时刻；E2E 靠它数「续期只打了一次」。 */
export interface DemoApiCall {
  method: string;
  path: string;
  at: number;
}
const CALL_LOG: DemoApiCall[] = [];
(window as unknown as { __demoApiLog: DemoApiCall[] }).__demoApiLog = CALL_LOG;

let satSeq = 0;

function grant(path: string): Response {
  const installationId = /installations\/([^/]+)\//u.exec(path)?.[1] ?? 'tsi_crm_01';
  satSeq += 1;
  return json({
    // 每次签发换一个值：子端才能分辨「续期真的换了令牌」而不是原样重放
    token: `demo.sat.token.${satSeq}`,
    tokenExp: Math.floor(Date.now() / 1000) + (plan().tokenExpSeconds ?? 300),
    user: { id: 'u_demo', displayName: '张三', isTenantAdmin: false },
    installationId,
    contractVersion: 1,
  });
}

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  CALLS.push(`${method} ${path}`);
  CALL_LOG.push({ method, path, at: Date.now() });

  if (path === '/api/systems/mine') return json({ installations: installations() });

  if (path.endsWith('/handshake/nonce')) {
    await delay(plan().nonceDelayMs);
    if (scenario() === 'handshake-failed') return json({ error: { code: 'unavailable' } }, 503);
    return json({ nonce: 'demo-nonce-'.padEnd(32, '0'), expiresAt: '' });
  }

  if (path.endsWith('/handshake/verify')) {
    await delay(plan().verifyDelayMs);
    return grant(path);
  }

  if (path.endsWith('/token')) {
    await delay(plan().tokenDelayMs);
    const failure = plan().tokenError;
    if (failure) {
      return json({ error: { code: failure.code ?? 'forbidden', message: '' } }, failure.status);
    }
    return grant(path);
  }

  if (path.endsWith('/shell-events')) return new Response(null, { status: 204 });

  if (path === '/api/billing/me/summary') {
    return json({
      summary: {
        balanceCredits: scenario() === 'credits' ? 0 : 1280,
        billingEnabled: true,
        billingMode: 'prepaid',
      },
    });
  }
  if (path === '/api/billing/me/budget') {
    return json({ budget: { monthlyLimitCredits: null, remainingCredits: null } });
  }

  return json({ error: { code: 'not_found', message: path } }, 404);
}

export function setOnUnauthorized(): void {
  /* 演示态没有会话过期 */
}

/**
 * WP4 壳 E2E 的公共夹具。
 *
 * 三件事：① 把演示态的场景/计划注入进去；② 装一个「握手相位时刻」观察器
 * （§9.3-15 要量的是 `src` 设置 → `init.ack`，不是页面 load）；③ 拿到 mock
 * 定制项目那个**跨源** frame 的句柄，好用 `frame.evaluate()` 直接发任意信封。
 *
 * 纪律：被测对象是**壳**，壳侧一行代码都没有为测试让路 —— 所有测试钩子都在
 * `web/demo/`（演示态，已由 `web/scripts/check-oss-dist.mjs` 三道断言钉死不进生产构建）。
 */
import { expect, type Frame, type Page } from 'playwright/test';

export const SHELL_ORIGIN = 'http://127.0.0.1:4190';
export const APP_ORIGIN = 'http://localhost:4191';
export const CRM_IID = 'tsi_crm_01';
export const WMS_IID = 'tsi_wms_01';
/** 演示态 CRM 实例 manifest 里的 `externalLinkHosts`。 */
export const ALLOWED_LINK_HOST = 'docs.kaiyan.net';

export type DemoScenario = 'ok' | 'disabled' | 'credits' | 'handshake-failed';

export interface DemoApiPlan {
  nonceDelayMs?: number;
  verifyDelayMs?: number;
  tokenDelayMs?: number;
  tokenExpSeconds?: number;
  tokenError?: { status: number; code?: string };
}

/** `web/demo/mock-app.html` 的 `window.__kyPlan`。 */
export interface MockAppPlan {
  contractVersion?: number;
  sendReady?: boolean;
  readyResendMs?: number;
  readyResendLimitMs?: number;
  ackInit?: boolean;
  ackInitAfter?: number;
  autoRouteResult?: boolean;
  autoRouteChangedEcho?: boolean;
  tall?: boolean;
}

export interface DemoApiCall {
  method: string;
  path: string;
  at: number;
  body: string | null;
}

export interface PhaseMark {
  mark: string;
  at: number;
}

export interface KyEnvelope {
  ns: string;
  v: number;
  type: string;
  id?: string;
  navId?: string;
  payload?: Record<string, unknown>;
}

export interface BootOptions {
  /** 壳路径，默认停在 CRM 实例的应用根。 */
  path?: string;
  scenario?: DemoScenario;
  api?: DemoApiPlan;
  app?: MockAppPlan;
}

export async function boot(page: Page, options: BootOptions = {}): Promise<void> {
  const payload = {
    scenario: options.scenario ?? 'ok',
    appOrigin: APP_ORIGIN,
    api: options.api ?? {},
    app: options.app ?? {},
  };
  await page.addInitScript((input: typeof payload) => {
    const win = window as unknown as Record<string, unknown>;
    win.__demoScenario = input.scenario;
    win.__demoAppOrigin = input.appOrigin;
    win.__demoApiPlan = input.api;
    win.__kyPlan = input.app;

    // ---- 握手相位时刻观察器（只在壳这一侧装；子端 frame 没有 app-host 节点）----
    // §9.3-15 的口径是「`src` 设置 → `init.ack` ≤ 3 s」，所以 t0 取 iframe 带着 src
    // 第一次出现在 DOM 上的时刻，t1 取相位变成 active 的时刻（`onInitAck` 里 patch 的）。
    const marks: { mark: string; at: number }[] = [];
    win.__phaseMarks = marks;
    let lastPhase: string | null = null;
    let frameSeen = false;
    const sample = () => {
      const host = document.querySelector('[data-testid="app-host"]');
      const phase = host?.getAttribute('data-app-host-phase') ?? null;
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        marks.push({ mark: `phase:${phase}`, at: performance.now() });
      }
      if (!frameSeen) {
        const frame = document.querySelector('[data-testid="app-host-frame"]');
        if (frame?.getAttribute('src')) {
          frameSeen = true;
          marks.push({ mark: 'frame:src', at: performance.now() });
        }
      }
    };
    new MutationObserver(sample).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-app-host-phase', 'src'],
    });
    document.addEventListener('DOMContentLoaded', sample);
  }, payload);

  await page.goto(`${SHELL_ORIGIN}${options.path ?? `/apps/${CRM_IID}`}`, {
    waitUntil: 'domcontentloaded',
  });
}

/** 等到壳把握手走完（子端已回 `init.ack`）。 */
export async function waitActive(page: Page): Promise<void> {
  await page.waitForSelector('[data-app-host-phase="active"]', { timeout: 20_000 });
}

/** mock 定制项目那个跨源 frame。Playwright 能跨源 `evaluate`，这是本套测试的手柄。 */
export async function appFrame(page: Page, marker = ''): Promise<Frame> {
  let found: Frame | undefined;
  // 只能轮询 `page.frames()`：DOM 里 iframe 已经在了，Playwright 的 frame attach
  // 事件还可能没到，先用 `waitForFunction` 看 DOM 会稳定地早一拍拿不到句柄。
  await expect
    .poll(
      () => {
        found = page
          .frames()
          .find((item) => item.url().startsWith(APP_ORIGIN) && item.url().includes(marker));
        return Boolean(found);
      },
      { timeout: 20_000, intervals: [50, 100, 200, 500] },
    )
    .toBe(true);
  const frame = found as Frame;
  // frame 刚出现时脚本可能还没跑完，等控制面就绪再交出去
  await frame.waitForFunction(() => Boolean((window as unknown as { __ky?: unknown }).__ky), null, {
    timeout: 20_000,
  });
  return frame;
}

/** 让 mock 定制项目发一条任意信封（用来造重复 `(type,id)`、伪造来源等场景）。 */
export async function sendFromApp(frame: Frame, envelope: KyEnvelope): Promise<void> {
  await frame.evaluate((message) => {
    (window as unknown as { __ky: { send: (m: unknown) => void } }).__ky.send(message);
  }, envelope);
}

export function appState(frame: Frame): Promise<{
  loadId: string;
  counters: { readySent: number; initReceived: number; initAckSent: number; routeNavigate: number };
  log: KyEnvelope[];
  sent: KyEnvelope[];
  scrollY: number;
}> {
  return frame.evaluate(() => {
    const api = (
      window as unknown as {
        __ky: {
          loadId: string;
          counters: Record<string, number>;
          log: unknown[];
          sent: unknown[];
        };
      }
    ).__ky;
    return {
      loadId: api.loadId,
      counters: api.counters,
      log: api.log,
      sent: api.sent,
      scrollY: window.scrollY,
    } as never;
  });
}

/** 壳打出去的平台 API 调用流水（含请求体）。 */
export function apiLog(page: Page): Promise<DemoApiCall[]> {
  return page.evaluate(
    () => (window as unknown as { __demoApiLog: DemoApiCall[] }).__demoApiLog ?? [],
  ) as Promise<DemoApiCall[]>;
}

export async function apiCallCount(page: Page, suffix: string): Promise<number> {
  const calls = await apiLog(page);
  return calls.filter((call) => call.path.endsWith(suffix)).length;
}

/** 壳落的安全事件（`/api/app-contract/v1/shell-events` 的请求体）。 */
export async function shellEvents(
  page: Page,
): Promise<{ event: string; installationId: string; reason?: string; detail?: string }[]> {
  const calls = await apiLog(page);
  return calls
    .filter((call) => call.path.endsWith('/shell-events') && call.body)
    .map((call) => JSON.parse(call.body as string));
}

export function phaseMarks(page: Page): Promise<PhaseMark[]> {
  return page.evaluate(
    () => (window as unknown as { __phaseMarks: PhaseMark[] }).__phaseMarks ?? [],
  ) as Promise<PhaseMark[]>;
}

/** §9.3-15 的被测区间：`src` 设置 → `init.ack`（相位变 active）。 */
export async function handshakeMillis(page: Page): Promise<number> {
  const marks = await phaseMarks(page);
  const start = marks.find((item) => item.mark === 'frame:src');
  const end = marks.find((item) => item.mark === 'phase:active');
  expect(start, '没有观察到 iframe src 被设置').toBeTruthy();
  expect(end, '没有观察到相位进入 active').toBeTruthy();
  return (end as PhaseMark).at - (start as PhaseMark).at;
}

export function shellUrlPath(page: Page): string {
  return new URL(page.url()).pathname + new URL(page.url()).search;
}

export function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

/**
 * 业务系统宿主（WP4，规范 §5）。
 *
 * 职责被切成两半：**状态机与消息路由在 `controller.ts`（纯 TS）**，本文件只做三件事 ——
 * 渲染快照、把 `iframe.contentWindow` 交给控制器、把壳侧能力（登出、URL、预填总线）接上。
 * 这样 4 个定时器 + 2 个单飞 + 1 个重放缓存不必被 React 的渲染时机牵着走。
 *
 * 本文件被 `lazy()` 加载：startup 只有 1 个 JS chunk 且 `largestJsGzipBytes`
 * 距上限只剩约 93 KB，AppHost 及其依赖一旦进主 chunk 必然撑破预算。
 *
 * **跨源 iframe 的安全取舍见 §5.1 与阶段记录 §3。** 概括：`allow-same-origin` 是
 * 必须给的（否则子帧拿不到自己的 storage / cookie，SDK 完全跑不起来），跨源下它
 * 只是「子帧拥有它自己的源」，真正的隔离靠子帧自己的 CSP；代价是壳这一侧必须
 * 把来源校验做死（`envelope.ts`），并且**不给** `allow-popups` / `allow-top-navigation`。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { useMySystems } from '@/hooks/useMySystems';
import { reportAppShellEvent } from '@/lib/appShellAudit';
import { requestAgentOpen } from '@/lib/agentOpenBus';
import { loadMySystems } from '@/lib/mySystemsSource';
import {
  navigateApps,
  SECURITY_RELEVANT_PATH_REJECTIONS,
  type AppsRouteState,
} from '@/lib/urlSync';
import { isSystemOpenable, type MySystemState } from '@/lib/systemsApi';
import { cn } from '@/lib/utils';
import { AppHostController, type AppHostSnapshot } from './controller';
import { describeAppHostFailure, type AppHostFailureKind } from './failureText';
import { openExternalLink } from './linkPolicy';
import * as handshakeApi from './handshakeApi';

/**
 * 挂载序号：每次真正 mount 自增一次。
 * §5.5 承诺「切走再切回保留页面与滚动位置」，实现手段是隐藏而不是卸载；
 * 把序号渲染到 DOM 上，测试才能钉死「切走再切回没有重挂载」。
 */
let mountSequence = 0;

/**
 * 非 `enabled` 的实例状态 → §6.6 的客户面失败种类。
 * `disabled`/`unavailable` 是「暂不可用」（停用 / `live` 失败，§5.5 同一行）；
 * `maintenance`/`needs_reregistration` 是「正在更新，暂不可操作」（§6.6 条幅行，可重试）。
 * 这里是偏差 4-B-06「壳侧无检测源」的接线点：检测源就是 `/api/systems/mine` 的 `state`。
 */
export function failureKindForState(state: MySystemState): AppHostFailureKind | null {
  switch (state) {
    case 'enabled':
      return null;
    case 'maintenance':
    case 'needs_reregistration':
      return 'system_updating';
    default:
      return 'unavailable';
  }
}

/** 没有 CDN、没有主题系统时的默认值；有了再从 documentElement 读。 */
function currentTheme(): string {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export interface AppHostProps {
  /** 当前壳路由；为 null 表示壳还没停在任何安装实例上。 */
  appsRoute: AppsRouteState | null;
}

const INITIAL: AppHostSnapshot = { phase: 'idle', frameSrc: null, failure: null, notice: null };

export function AppHost({ appsRoute }: AppHostProps) {
  const [mountId] = useState(() => {
    mountSequence += 1;
    return mountSequence;
  });
  const { logout } = useAuth();
  const { status, installations } = useMySystems();
  const [snapshot, setSnapshot] = useState<AppHostSnapshot>(INITIAL);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  /** 控制器活得比一次渲染长，URL 回写要读「此刻停在哪个实例」，所以用 ref 而不是闭包捕获。 */
  const currentInstallationIdRef = useRef<string | null>(appsRoute?.installationId ?? null);
  currentInstallationIdRef.current = appsRoute?.installationId ?? null;

  const [controller] = useState(
    () =>
      new AppHostController({
        api: {
          nonce: handshakeApi.requestHandshakeNonce,
          verify: handshakeApi.verifyHandshake,
          refresh: handshakeApi.refreshUserToken,
        },
        audit: (input) => {
          void reportAppShellEvent(input);
        },
        onChange: setSnapshot,
        onAgentOpen: requestAgentOpen,
        onLogout: () => {
          void logoutRef.current();
        },
        onAppPath: (path, mode) => {
          const installationId = currentInstallationIdRef.current;
          if (!installationId) return;
          // 必须走 `navigateApps`（push/replace **+ notifyRouteChange**），不能直接用
          // `pushAppsUrl`/`replaceAppsUrl`：那两个只动 history，不通知订阅者。
          // 少这一声通知的后果不是「data-app-path 显示得不对」这么轻 —— 子端自发跳转后
          // `useAppsShellState` 还停在旧路由，用户再按浏览器后退键时 `sameRoute()` 判定
          // 「没变」，壳就不会给子端发 `route.navigate`，**后退键对应用内导航整个失效**。
          // 不会自激：`onRouteChanged`/`onReady` 都先更新了 `this.appPath`，
          // 回灌进来的 `mount()` 在同实例同路径上直接早返回。
          navigateApps({ installationId, appPath: path }, { replace: mode === 'replace' });
        },
        onPermissionMaybeChanged: () => {
          void loadMySystems({ force: true }).catch(() => {
            /* 失败态由单一来源广播 */
          });
        },
        theme: currentTheme,
        openLink: (url) => openExternalLink(url),
      }),
  );

  /**
   * §5.5/§11.1「切走再切回保留页面与滚动位置」的落点。
   *
   * 切到 Agent 标签时壳 URL 离开 `/apps/**`，`appsRoute` 变 null。若按它渲染，
   * 下面的 `!appsRoute` 分支会把 iframe 整个从 DOM 摘掉 —— 子端重载、滚动位置与
   * 页内状态全部丢失，`DesktopLayout` 那边「惰性挂载 + hidden 隐藏不卸载」也就白做了。
   * 因此**渲染**认「最后一次停留过的路由」，**副作用**（握手、URL 回写）仍然只认
   * 真实的 `appsRoute`：隐藏期间不重新握手，子端自己跳路由也不会把用户从聊天里拽走。
   */
  const [stickyRoute, setStickyRoute] = useState<AppsRouteState | null>(appsRoute);
  useEffect(() => {
    if (appsRoute) setStickyRoute(appsRoute);
  }, [appsRoute]);
  const renderRoute = appsRoute ?? stickyRoute;

  const installation =
    installations.find((item) => item.installationId === renderRoute?.installationId) ?? null;
  const openable = installation !== null && isSystemOpenable(installation);
  /**
   * §5.5/§6.6：**停用不是「从列表里消失」**，服务端会把停用实例连同 `state` 一起返回，
   * 所以这里既拿得到《系统名》，也分得清「停用/暂不可用」与「正在更新」（收掉 4-B-04）。
   * 列表已就绪却查无此实例，才是「已删除 / 不再对本人可见」那一档，回落无名文案。
   */
  const stateFailureKind: AppHostFailureKind | null = !renderRoute || status !== 'ready'
    ? null
    : installation === null
      ? 'unavailable'
      : failureKindForState(installation.state);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      void controller.handleMessage(event);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [controller]);

  useEffect(() => {
    // 不可进入的实例一律不握手：不生成 nonce、不挂 iframe、不签 SAT。
    if (!appsRoute || !installation || !openable) return;
    void controller.mount(
      {
        installationId: installation.installationId,
        name: installation.name,
        origin: installation.origin,
        externalLinkHosts: installation.externalLinkHosts,
      },
      appsRoute.appPath,
    );
  }, [controller, installation, openable, appsRoute]);

  // 4-A-01：非法应用内路径已回落首页，这里补轻提示与安全事件。
  // 放在挂载 effect 之后声明：`controller.mount` 会先把 installation 装上，
  // 审计事件才有 installationId 可带。
  const rejectedReason = appsRoute?.rejectedReason ?? null;
  useEffect(() => {
    if (!rejectedReason) return;
    // 安装实例是审计事件的必填项，而它要等 `/api/systems/mine` 回来才知道；
    // 因此把它放进依赖：先出提示，等实例到位再补上安全事件。
    controller.noteInvalidPath(
      rejectedReason,
      (SECURITY_RELEVANT_PATH_REJECTIONS as readonly string[]).includes(rejectedReason),
    );
  }, [controller, rejectedReason, installation?.installationId]);

  // contentWindow 必须在第一条消息之前交给控制器，否则 event.source 校验会把
  // 合法的首条 ready 也拒掉。src 一变就重挂 window（iframe 换文档会换 contentWindow）。
  const attachFrame = useCallback(
    (node: HTMLIFrameElement | null) => {
      frameRef.current = node;
      controller.setFrameWindow(node?.contentWindow ?? null);
    },
    [controller],
  );
  useEffect(() => {
    controller.setFrameWindow(frameRef.current?.contentWindow ?? null);
  }, [controller, snapshot.frameSrc]);

  const failure = stateFailureKind
    ? {
        kind: stateFailureKind,
        // 查无此实例时才拿不到名字，`describeAppHostFailure` 回落成「该系统」
        ...describeAppHostFailure(stateFailureKind, installation?.name ?? null),
      }
    : snapshot.failure;

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="app-host"
      data-app-host-mount={mountId}
      data-app-host-phase={snapshot.phase}
      data-installation-id={renderRoute?.installationId ?? ''}
      data-app-path={renderRoute?.appPath ?? ''}
      data-app-host-visible={appsRoute ? 'true' : 'false'}
    >
      {snapshot.notice && (
        <div
          data-testid="app-host-notice"
          className={cn(
            'flex items-center justify-between gap-3 border-b px-4 py-2 text-sm',
            snapshot.notice.level === 'error'
              ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200'
              : snapshot.notice.level === 'warning'
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
                : 'bg-muted text-muted-foreground',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{snapshot.notice.message}</span>
          <button
            type="button"
            className="shrink-0 text-xs underline-offset-2 hover:underline"
            onClick={() => controller.dismissNotice()}
          >
            知道了
          </button>
        </div>
      )}

      {!renderRoute ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          请选择一个业务系统
        </div>
      ) : failure ? (
        <div
          data-testid="app-host-failure"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <p className="text-sm text-muted-foreground">{failure.message}</p>
          {failure.retryable && (
            <button
              type="button"
              data-testid="app-host-retry"
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={() => {
                // 状态是服务端算的，重试要重新问服务端；只有握手类失败才重走握手。
                if (stateFailureKind) {
                  void loadMySystems({ force: true }).catch(() => {
                    /* 失败态由单一来源广播 */
                  });
                  return;
                }
                void controller.retry();
              }}
            >
              重试
            </button>
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {snapshot.frameSrc && (
            // §5.1 一字不差：无 allow-popups / allow-top-navigation
            <iframe
              ref={attachFrame}
              key={installation?.installationId ?? 'none'}
              data-testid="app-host-frame"
              title={installation?.name ?? '业务系统'}
              src={snapshot.frameSrc}
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
              allow="clipboard-write"
              referrerPolicy="strict-origin"
              className="size-full border-0"
            />
          )}
          {snapshot.phase !== 'active' && (
            <div
              data-testid="app-host-loading"
              className="absolute inset-0 flex items-center justify-center bg-background/80"
            >
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AppHost;

/**
 * 定制软件宿主（WP4，规范 §5）。
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
import { replaceAppsUrl, pushAppsUrl, type AppsRouteState } from '@/lib/urlSync';
import { cn } from '@/lib/utils';
import { AppHostController, type AppHostSnapshot } from './controller';
import { describeAppHostFailure } from './failureText';
import { openExternalLink } from './linkPolicy';
import * as handshakeApi from './handshakeApi';

/**
 * 挂载序号：每次真正 mount 自增一次。
 * §5.5 承诺「切走再切回保留页面与滚动位置」，实现手段是隐藏而不是卸载；
 * 把序号渲染到 DOM 上，测试才能钉死「切走再切回没有重挂载」。
 */
let mountSequence = 0;

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
          const next = { installationId, appPath: path };
          if (mode === 'push') pushAppsUrl(next);
          else replaceAppsUrl(next);
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

  const installation =
    installations.find((item) => item.installationId === appsRoute?.installationId) ?? null;
  // §6.6：列表已就绪却查无此实例 = 已停用 / 不再对本人可见
  const unavailable = Boolean(appsRoute) && status === 'ready' && installation === null;

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      void controller.handleMessage(event);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [controller]);

  useEffect(() => {
    if (!appsRoute || !installation) return;
    void controller.mount(
      {
        installationId: installation.installationId,
        name: installation.name,
        origin: installation.origin,
        externalLinkHosts: installation.externalLinkHosts,
      },
      appsRoute.appPath,
    );
  }, [controller, installation, appsRoute]);

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

  const failure = unavailable
    ? // 查无此实例时连名字都拿不到，`describeAppHostFailure` 会回落成「该系统」
      { kind: 'unavailable' as const, ...describeAppHostFailure('unavailable', null) }
    : snapshot.failure;

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="app-host"
      data-app-host-mount={mountId}
      data-app-host-phase={snapshot.phase}
      data-installation-id={appsRoute?.installationId ?? ''}
      data-app-path={appsRoute?.appPath ?? ''}
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

      {!appsRoute ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          请选择一个定制软件
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
              title={installation?.name ?? '定制软件'}
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

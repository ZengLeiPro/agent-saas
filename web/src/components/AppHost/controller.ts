/**
 * AppHost 握手状态机与 §5.4 消息路由器（壳侧），与 React 解耦。
 *
 * **逐条移植自 `packages/ky-app-cli/assets/shell.html`**，不从规范文字重写；
 * 「shell.html 行 → 本文件落点」的对照表在
 * `assets/20260906/WP4施工/04-PhaseB-AppHost与消息路由.md` §2。
 * shell.html 与规范 §5.3/§5.4 不一致处以规范为准，已在偏差记录里逐条登记。
 *
 * 为什么不写成 hook：状态机有 4 个定时器、2 个单飞、1 个重放缓存，
 * 用 React state 表达会被渲染时机牵着走；这里做成普通类，React 只负责
 * 「渲染 state」「把 iframe 的 contentWindow 交进来」两件事，测试也能用假定时器精确跑。
 */
import {
  HANDSHAKE_INIT_RESEND_MAX,
  HANDSHAKE_READY_TIMEOUT_MS,
  MESSAGE_RESPONSE_TIMEOUT_MS,
  CONTRACT_VERSION,
  type HandshakeState,
  type TokenRefreshErrorReason,
} from '@kaiyan/ky-app-contract/browser';

import type { AppShellEvent } from '@/lib/appShellAudit';
import { buildAgentOpenPrefill } from '@/lib/agentOpenBus';
import { buildOutgoingEnvelope, classifyIncomingMessage } from './envelope';
import type { EnvelopeRejectReason, IncomingEnvelope } from './envelope';
import {
  describeAppHostFailure,
  systemLabel,
  INVALID_PATH_NOTICE,
  PERMISSION_CHANGED_NOTICE,
} from './failureText';
import type { AppHostFailureKind } from './failureText';
import { buildFrameSrc, refreshErrorReason } from './handshakeApi';
import type { HandshakeGrant, HandshakeNonce } from './handshakeApi';
import { checkExternalLink, externalLinkConfirmText } from './linkPolicy';
import type { LinkRejectReason } from './linkPolicy';
import { ReplayCache, replayKey } from './replayCache';

/** §5.4-4：壳 5 s 未收到 `init.ack` 重发 `init`。 */
const INIT_ACK_TIMEOUT_MS = 5000;
/** 回前台时令牌剩余不足这么多秒就先续期再唤醒（§5.4「回前台先确保令牌有效」）。 */
const TOKEN_REFRESH_LEEWAY_SECONDS = 30;

export interface AppHostInstallation {
  installationId: string;
  name: string;
  origin: string;
  /** manifest 的 `externalLinkHosts`；拿不到时为空数组 → `link.open` fail-closed。 */
  externalLinkHosts: readonly string[];
}

export interface AppHostSnapshot {
  phase: HandshakeState | 'idle';
  frameSrc: string | null;
  failure: { kind: AppHostFailureKind; message: string; retryable: boolean } | null;
  /** 壳内条幅（子端 `toast`、非法链接回落、权限变更）；壳里没有 toast 组件，用条幅承载。 */
  notice: { level: 'info' | 'success' | 'warning' | 'error'; message: string } | null;
}

export interface AppHostDeps {
  api: {
    nonce: (installationId: string) => Promise<HandshakeNonce>;
    verify: (
      installationId: string,
      input: { nonce: string; attestation: string },
    ) => Promise<HandshakeGrant>;
    refresh: (installationId: string) => Promise<HandshakeGrant>;
  };
  /** 壳侧安全事件与 `agent.open` 审计；fire-and-forget。 */
  audit: (input: {
    event: AppShellEvent;
    installationId: string;
    reason?: string;
    detail?: string;
  }) => void;
  onChange: (snapshot: AppHostSnapshot) => void;
  /** `agent.open`：切 Agent 标签并预填（不自动发送）。 */
  onAgentOpen: (input: { text: string; installationId: string }) => void;
  /** `logout.request`：壳执行自身登出。 */
  onLogout: () => void;
  /** 应用内路径变了，壳要同步 URL（§5.2 的 push / replace 归属规则）。 */
  onAppPath: (path: string, mode: 'push' | 'replace') => void;
  /** 权限可能变了（`perm.changed` / `route.result{forbidden}`）：重拉可见系统。 */
  onPermissionMaybeChanged: () => void;
  theme: () => string;
  locale?: string;
  confirm?: (message: string) => boolean;
  openLink?: (url: string) => boolean;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** 需应答消息的应答；缓存它才能在重复 `(type,id)` 到达时原样重放。 */
interface OutgoingReply {
  type: string;
  payload: unknown;
}

interface PendingNavigation {
  navId: string;
  resolve: (result: { ok: boolean; reason?: string; path?: string }) => void;
  timer: number;
}

const IDLE: AppHostSnapshot = { phase: 'idle', frameSrc: null, failure: null, notice: null };

export class AppHostController {
  private snapshot: AppHostSnapshot = IDLE;
  private installation: AppHostInstallation | null = null;
  private appPath = '/';
  private nonce: string | null = null;
  private frameWindow: Window | null = null;
  private grant: HandshakeGrant | null = null;

  /**
   * §5.3 重复 `(type,id)` 重放缓存：ready / token.request / link.open 三类需应答消息共用。
   * 缓存的是**应答信封本身**，重复消息到达时原样再发一次 —— 只缓存副作用、
   * 不重发应答的话，子端等不到回话，等于把重复当丢弃处理，正是规范禁止的做法。
   */
  private readonly replies = new ReplayCache<OutgoingReply | null>();
  private readyTimer: number | null = null;
  private initAckTimer: number | null = null;
  private initResends = 0;
  private initReplyToId: string | null = null;
  /** 401 单飞：并发的 `token.request` 只触发一次续期。 */
  private refreshInflight: Promise<HandshakeGrant> | null = null;
  private navSeq = 0;
  private pendingNavigations = new Map<string, PendingNavigation>();
  /** 壳自己发起的导航 navId；`route.changed` 带同一个 navId 即为回声。 */
  private readonly ownNavIds = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: AppHostDeps) {}

  get state(): AppHostSnapshot {
    return this.snapshot;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timer(handler: () => void, ms: number): number {
    return (this.deps.setTimer ?? ((fn, delay) => window.setTimeout(fn, delay)))(handler, ms);
  }

  private cancel(handle: number | null): void {
    if (handle === null) return;
    (this.deps.clearTimer ?? ((value: number) => window.clearTimeout(value)))(handle);
  }

  private patch(next: Partial<AppHostSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.deps.onChange(this.snapshot);
  }

  private fail(kind: AppHostFailureKind): void {
    const text = describeAppHostFailure(kind, this.installation?.name);
    this.cancel(this.readyTimer);
    this.cancel(this.initAckTimer);
    this.readyTimer = null;
    this.initAckTimer = null;
    this.patch({ phase: 'loading', frameSrc: null, failure: { kind, ...text } });
  }

  private report(event: AppShellEvent, reason?: string, detail?: string): void {
    const installationId = this.installation?.installationId;
    if (!installationId) return;
    this.deps.audit({
      event,
      installationId,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * 挂载 / 切换安装实例。同一实例只是换应用内路径时**不重新握手** ——
   * 重新握手等于重载 iframe，§5.5 承诺的「保留页面与滚动位置」就废了；
   * 走 `route.navigate` 让子端自己路由。
   */
  async mount(installation: AppHostInstallation, appPath: string): Promise<void> {
    const sameInstallation = this.installation?.installationId === installation.installationId;
    this.installation = installation;
    if (sameInstallation && this.snapshot.phase === 'active') {
      if (appPath !== this.appPath) {
        this.appPath = appPath;
        // 不 await：`route.result` 最长要等 5 s，挂载流程不该被子端的应答堵住
        void this.navigate(appPath);
      }
      return;
    }
    /**
     * 同实例、握手还在路上（attesting/ready/init）：**不重新握手**。
     * 重新握手 = 换 nonce 换 src = iframe 重载，握手期间被打断一次就永远收敛不了。
     * 而这条路径是真会走到的：`onReady` 拿 `ready.path` 做 canonical 时会
     * `replaceState` 并通知订阅者，回灌回来的 `mount()` 携带的正是新路径。
     * 路径以壳这边记的为准，`ready.path` 那一步已经把它对齐过了。
     */
    const handshakeInFlight =
      this.snapshot.phase !== 'idle' && this.snapshot.phase !== 'active' && !this.snapshot.failure;
    if (sameInstallation && handshakeInFlight) return;

    this.appPath = appPath;
    await this.handshake();
  }

  /** §6.6 的「重试」按钮。 */
  retry(): Promise<void> {
    return this.handshake();
  }

  private async handshake(): Promise<void> {
    const installation = this.installation;
    if (!installation) return;
    this.reset();
    this.patch({ phase: 'loading', failure: null, frameSrc: null });
    let issued: HandshakeNonce;
    try {
      issued = await this.deps.api.nonce(installation.installationId);
    } catch {
      // 拿不到 nonce 就没有握手可言；与证明失败同一条客户面文案（§6.6 第一行）
      this.report('handshake_failed', 'nonce_unavailable');
      this.fail('handshake_failed');
      return;
    }
    if (this.disposed || this.installation !== installation) return;
    this.nonce = issued.nonce;
    const frameSrc = buildFrameSrc({
      origin: installation.origin,
      appPath: this.appPath,
      installationId: installation.installationId,
      nonce: issued.nonce,
    });
    this.patch({ phase: 'attesting', frameSrc });
    // §5.4：子端每 1 s 重发 ready，上限 10 s。10 s 还没有合法 ready 就是握手失败。
    this.readyTimer = this.timer(() => {
      this.report('handshake_failed', 'ready_timeout');
      this.fail('handshake_failed');
    }, HANDSHAKE_READY_TIMEOUT_MS);
  }

  setFrameWindow(frameWindow: Window | null): void {
    this.frameWindow = frameWindow;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private reset(): void {
    this.cancel(this.readyTimer);
    this.cancel(this.initAckTimer);
    for (const pending of this.pendingNavigations.values()) this.cancel(pending.timer);
    this.pendingNavigations.clear();
    this.ownNavIds.clear();
    this.replies.clear();
    this.readyTimer = null;
    this.initAckTimer = null;
    this.initResends = 0;
    this.initReplyToId = null;
    this.refreshInflight = null;
    this.grant = null;
    this.nonce = null;
  }

  private post(type: string, payload?: unknown, extra: { id?: string; navId?: string } = {}): void {
    const origin = this.installation?.origin;
    if (!origin || !this.frameWindow) return;
    // 精确 targetOrigin（§5.3）：这里写 '*' 就等于把 SAT 广播给任意接管了该帧的页面
    this.frameWindow.postMessage(buildOutgoingEnvelope(type, payload, extra), origin);
  }

  /** window message 监听入口。返回值只用于测试观察拒绝原因。 */
  async handleMessage(
    event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  ): Promise<EnvelopeRejectReason | null> {
    const verdict = classifyIncomingMessage(event, {
      appOrigin: this.installation?.origin ?? null,
      frameWindow: this.frameWindow,
    });
    if (!verdict.ok) {
      // origin / source 两类是有人在试着伪造来源，落安全事件；其余是噪音
      if (verdict.reason === 'origin' || verdict.reason === 'source') {
        this.report('message_rejected', verdict.reason, String(event.origin).slice(0, 200));
      }
      return verdict.reason;
    }
    await this.dispatch(verdict.envelope);
    return null;
  }

  private async dispatch(envelope: IncomingEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    switch (envelope.type) {
      case 'ready':
        await this.onceById(envelope, () => this.onReady(envelope, payload));
        return;
      case 'init.ack':
        this.onInitAck();
        return;
      case 'token.request':
        await this.onceById(envelope, () => this.onTokenRequest());
        return;
      case 'route.result':
        this.onRouteResult(envelope, payload);
        return;
      case 'route.changed':
        this.onRouteChanged(envelope, payload);
        return;
      case 'perm.changed':
        this.deps.onPermissionMaybeChanged();
        return;
      case 'agent.open':
        this.onAgentOpen(payload);
        return;
      case 'link.open':
        await this.onceById(envelope, () => this.onLinkOpen(payload));
        return;
      case 'toast':
        this.onToast(payload);
        return;
      case 'logout.request':
        this.reset();
        this.patch({ phase: 'idle', frameSrc: null, ...describeLogout() });
        this.deps.onLogout();
        return;
    }
  }

  /**
   * §5.3：需应答消息按 `(type,id)` 去重 —— **副作用只跑一次，应答每次都重放**。
   * 没带 `id` 的按「不需要应答」处理，直接执行（子端不指望回话）。
   */
  private async onceById(
    envelope: IncomingEnvelope,
    run: () => Promise<OutgoingReply | null>,
  ): Promise<void> {
    const reply = envelope.id
      ? await this.replies.runOnce(replayKey(envelope.type, envelope.id), run)
      : await run();
    if (!reply) return;
    this.post(reply.type, reply.payload, envelope.id ? { id: envelope.id } : {});
  }

  // ---- ready → verify → init（shell.html:311-339）----

  private async onReady(
    envelope: IncomingEnvelope,
    payload: Record<string, unknown>,
  ): Promise<OutgoingReply | null> {
    // §8.3 / §9.3-16：壳只接受 contractVersion=1，其余进错误页
    if (payload.contractVersion !== CONTRACT_VERSION) {
      this.fail('contract_version_mismatch');
      return null;
    }
    const installation = this.installation;
    const nonce = this.nonce;
    if (!installation || !nonce) return null;
    this.cancel(this.readyTimer);
    this.readyTimer = null;
    this.patch({ phase: 'ready' });

    let grant: HandshakeGrant;
    try {
      grant = await this.deps.api.verify(installation.installationId, {
        nonce,
        attestation: typeof payload.attestation === 'string' ? payload.attestation : '',
      });
    } catch {
      this.report('attestation_failed', 'verify_rejected');
      this.fail('handshake_failed');
      return null;
    }
    if (this.disposed || this.installation !== installation) return null;
    this.grant = grant;

    // §5.2：`ready.path` 作 canonical，壳用 replaceState 把 URL 洗成它
    const readyPath = typeof payload.path === 'string' ? payload.path : null;
    if (readyPath && readyPath !== this.appPath) {
      this.appPath = readyPath;
      this.deps.onAppPath(readyPath, 'replace');
    }

    this.initReplyToId = envelope.id ?? `init-${this.now}`;
    this.patch({ phase: 'init' });
    // §5.4-4 的重发定时器只在首次 ready 时上弦；重复 ready 走重放，不会再进到这里
    this.armInitAckTimer();
    return { type: 'init', payload: this.initPayload() };
  }

  /**
   * `init` 载荷是**字段白名单**：只有 SAT 与最小用户信息，
   * 壳会话 JWT、authEpoch、租户 id、偏好设置一概不下发（施工总则 §3.2-7）。
   */
  private initPayload(): Record<string, unknown> {
    const grant = this.grant;
    const installation = this.installation;
    if (!grant || !installation) return {};
    return {
      token: grant.token,
      tokenExp: grant.tokenExp,
      user: {
        id: grant.user.id,
        displayName: grant.user.displayName,
        isTenantAdmin: grant.user.isTenantAdmin,
      },
      theme: this.deps.theme(),
      locale: this.deps.locale ?? 'zh-CN',
      installationId: installation.installationId,
      contractVersion: CONTRACT_VERSION,
    };
  }

  /** 重发（§5.4-4）。首发走 `onceById` 的应答通道，这里只管超时补发。 */
  private resendInit(): void {
    if (!this.grant) return;
    this.post('init', this.initPayload(), { id: this.initReplyToId ?? undefined });
    this.armInitAckTimer();
  }

  /** §5.4-4：5 s 没等到 `init.ack` 就重发，最多 3 次（shell.html:240-250）。 */
  private armInitAckTimer(): void {
    this.cancel(this.initAckTimer);
    this.initAckTimer = this.timer(() => {
      if (this.initResends >= HANDSHAKE_INIT_RESEND_MAX) {
        this.report('handshake_failed', 'init_ack_timeout');
        this.fail('handshake_failed');
        return;
      }
      this.initResends += 1;
      this.resendInit();
    }, INIT_ACK_TIMEOUT_MS);
  }

  private onInitAck(): void {
    this.cancel(this.initAckTimer);
    this.initAckTimer = null;
    this.patch({ phase: 'active', failure: null });
  }

  // ---- token.request → token.refresh | token.refresh.error（shell.html:350-364）----

  private async onTokenRequest(): Promise<OutgoingReply | null> {
    const installation = this.installation;
    if (!installation) return null;
    try {
      const grant = await this.singleFlightRefresh(installation.installationId);
      this.grant = grant;
      return { type: 'token.refresh', payload: { token: grant.token, tokenExp: grant.tokenExp } };
    } catch (error) {
      const reason = refreshErrorReason(error);
      this.applyRefreshFailure(reason);
      return { type: 'token.refresh.error', payload: { reason } };
    }
  }

  /** 401 单飞：并发的多条 `token.request` 只打一次续期端点。 */
  private singleFlightRefresh(installationId: string): Promise<HandshakeGrant> {
    if (this.refreshInflight) return this.refreshInflight;
    const request = this.deps.api.refresh(installationId).finally(() => {
      if (this.refreshInflight === request) this.refreshInflight = null;
    });
    this.refreshInflight = request;
    return request;
  }

  /**
   * §5.4：`temporary` 交给子端指数退避重试，壳保持现状（不把用户从页面上踢走）；
   * 其余三个是终止性的，壳停下来并显示文案。
   */
  private applyRefreshFailure(reason: TokenRefreshErrorReason): void {
    if (reason === 'temporary') return;
    if (reason === 'session_expired') this.fail('session_expired');
    else if (reason === 'installation_disabled') this.fail('unavailable');
    else this.fail('user_disabled');
  }

  // ---- 路由（§5.2）----

  /** 壳 → 子导航；等 `route.result`，5 s 超时（§5.3）。 */
  navigate(path: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
    this.navSeq += 1;
    const id = `nav-${this.navSeq}`;
    const navId = `navid-${this.navSeq}`;
    this.ownNavIds.add(navId);
    return new Promise((resolve) => {
      const timer = this.timer(() => {
        this.pendingNavigations.delete(id);
        resolve({ ok: false, reason: 'timeout' });
      }, MESSAGE_RESPONSE_TIMEOUT_MS);
      this.pendingNavigations.set(id, { navId, resolve, timer });
      this.post('route.navigate', { path }, { id, navId });
    });
  }

  private onRouteResult(envelope: IncomingEnvelope, payload: Record<string, unknown>): void {
    const pending = envelope.id ? this.pendingNavigations.get(envelope.id) : undefined;
    if (pending && envelope.id) {
      this.cancel(pending.timer);
      this.pendingNavigations.delete(envelope.id);
      pending.resolve({
        ok: payload.ok === true,
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
        ...(typeof payload.path === 'string' ? { path: payload.path } : {}),
      });
    }
    if (payload.ok === true) return;
    if (payload.reason === 'forbidden') {
      // §5.4：forbidden → 壳刷新 /me、导航 landing；§6.6：自动回首页并提示「权限已更新」
      this.deps.onPermissionMaybeChanged();
      this.appPath = '/';
      this.deps.onAppPath('/', 'replace');
      this.patch({ notice: { level: 'warning', message: PERMISSION_CHANGED_NOTICE } });
      void this.navigate('/');
      return;
    }
    // not_found / 超时：回落应用根并洗 URL（总控对 4-A-01 的拍板）
    this.appPath = '/';
    this.deps.onAppPath('/', 'replace');
    this.patch({ notice: { level: 'warning', message: INVALID_PATH_NOTICE } });
  }

  private onRouteChanged(envelope: IncomingEnvelope, payload: Record<string, unknown>): void {
    const path = typeof payload.path === 'string' ? payload.path : null;
    if (!path) return;
    this.appPath = path;
    // 回声抑制：带着壳自己发出的 navId 回来 = 这次跳转是壳发起的，用 replaceState 收敛，
    // 不能 pushState，否则「壳发起一次导航 = 历史里多两条」，后退键行为就错了。
    const echo = typeof envelope.navId === 'string' && this.ownNavIds.has(envelope.navId);
    if (echo && envelope.navId) this.ownNavIds.delete(envelope.navId);
    this.deps.onAppPath(path, echo ? 'replace' : 'push');
  }

  // ---- agent.open / link.open / toast（§5.4）----

  /**
   * §5.4：壳切 Agent 标签、**只预填不自动发送**、标注「来自《系统名》」。
   * 不自动发送是安全底线：能直接让 Agent 发消息 = 被嵌套的定制项目拿到了
   * 用户身份下的任意提示词注入，人必须留在回路里。
   */
  private onAgentOpen(payload: Record<string, unknown>): void {
    const installation = this.installation;
    if (!installation) return;
    this.report('agent_open');
    this.deps.onAgentOpen({
      text: buildAgentOpenPrefill(payload, systemLabel(installation.name)),
      installationId: installation.installationId,
    });
  }

  private async onLinkOpen(payload: Record<string, unknown>): Promise<OutgoingReply | null> {
    const installation = this.installation;
    if (!installation) return null;
    const verdict = checkExternalLink(payload.url, installation.externalLinkHosts);
    if (!verdict.ok) {
      this.report(
        'link_blocked',
        verdict.reason as LinkRejectReason,
        String(payload.url).slice(0, 200),
      );
      return { type: 'link.result', payload: { ok: false } };
    }
    const confirm = this.deps.confirm ?? ((message: string) => window.confirm(message));
    if (!confirm(externalLinkConfirmText(verdict.displayHost ?? ''))) {
      return { type: 'link.result', payload: { ok: false } };
    }
    const open = this.deps.openLink;
    const opened = open ? open(verdict.url ?? '') : false;
    return { type: 'link.result', payload: { ok: opened } };
  }

  private onToast(payload: Record<string, unknown>): void {
    const message = typeof payload.message === 'string' ? payload.message.slice(0, 200) : '';
    if (!message) return;
    const level = payload.level;
    this.patch({
      notice: {
        level: level === 'success' || level === 'warning' || level === 'error' ? level : 'info',
        message,
      },
    });
  }

  /**
   * 4-A-01：壳 URL 里出现非法应用内路径。路径已由 `parseAppsPath` 回落到应用根、
   * 由统一 `replaceState` 通道洗干净，这里只补总控要的两件事 ——
   * 一句不写技术归因的轻提示，以及可能是攻击尝试的那几类原因落安全事件。
   */
  noteInvalidPath(reason: string, securityRelevant: boolean): void {
    if (securityRelevant) this.report('path_rejected', reason);
    this.patch({ notice: { level: 'warning', message: INVALID_PATH_NOTICE } });
  }

  dismissNotice(): void {
    this.patch({ notice: null });
  }

  // ---- 壳 → 子的主动通知 ----

  setTheme(theme: string): void {
    this.post('theme.changed', { theme });
  }

  /** §5.4：回前台先确保令牌有效，再发 `visibility`。 */
  async setVisibility(visible: boolean): Promise<void> {
    const installation = this.installation;
    if (visible && installation && this.grant) {
      const secondsLeft = this.grant.tokenExp - Math.floor(this.now / 1000);
      if (secondsLeft <= TOKEN_REFRESH_LEEWAY_SECONDS) {
        try {
          const grant = await this.singleFlightRefresh(installation.installationId);
          this.grant = grant;
          this.post('token.refresh', { token: grant.token, tokenExp: grant.tokenExp });
        } catch (error) {
          const reason = refreshErrorReason(error);
          this.post('token.refresh.error', { reason });
          this.applyRefreshFailure(reason);
          return;
        }
      }
    }
    this.post('visibility', { visible });
  }
}

function describeLogout(): Pick<AppHostSnapshot, 'failure'> {
  const text = describeAppHostFailure('logged_out', null);
  return { failure: { kind: 'logged_out', ...text } };
}

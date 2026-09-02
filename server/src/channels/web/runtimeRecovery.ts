import type { WebSocket } from 'ws';
import { chatLogger } from '../../utils/logger.js';
import { findTranscriptOrMetaPathBySessionId } from '../../data/transcripts/index.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import { projectRunLiveness, type RunLiveness } from '../../runtime/runLiveness.js';
import type { EventStore } from '../../runtime/types.js';
import type { RunStore } from '../../runtime/runStore.js';
import { loadResolvedInteractionIds, scanBufferForPendingInteractions } from './interactionRecovery.js';
import { interactionStore } from './interactionStore.js';
import { EventBufferStore } from './eventBuffer.js';
import { getDurableEventCursor, isDurableCursorAtOrBefore, projectRuntimePlatformEvent, type RuntimeStreamProjectionState } from './runtimeEventProjection.js';
import { resolveResumeDurableBinding, type ResumeDurableBinding } from './resumeDurableBinding.js';
import { LifecycleRecoveryRequestLedger } from './lifecycleRecoveryProtocol.js';
import { buildChatQueueSnapshot } from './chatQueueSnapshot.js';
import { buildSyncOverflowFrame, type SyncPendingInteractionSnapshot, type SyncSessionSnapshot } from './syncProtocol.js';
import type { WebChannelRuntimeConfig } from './channelConfig.js';
import type { SensitiveActionTarget } from './wsAuthorization.js';
import type { WsAttachActiveStreamMessage, WsQueueSnapshotMessage, WsResumeMessage, WsSyncMessage } from './wsTypes.js';
import type { WsClient, WsServer } from './wsServer.js';

interface ActiveStreamBinding {
  ws: WebSocket;
  sessionId?: string;
  runId?: string;
}

interface RuntimeRecoveryHost {
  config: WebChannelRuntimeConfig;
  eventBufferStore: EventBufferStore;
  wsActiveStream: WeakMap<WebSocket, string>;
  resumeSubscriptions: WeakMap<WebSocket, () => void>;
  resumeChains: WeakMap<WebSocket, Promise<void>>;
  wsSessionAffinity: WeakMap<WebSocket, string>;
  getWsServer(): WsServer | undefined;
  getActiveStream(streamId: string): ActiveStreamBinding | undefined;
  findActiveStreamIdBySession(sessionId: string): string | undefined;
  findActiveStreamByRunId(runId: string): { streamId: string; entry: ActiveStreamBinding } | undefined;
  sensitiveActionAccessError(client: WsClient, target: SensitiveActionTarget): string | null;
  anonymousBindingAccessError(client: WsClient, boundWebSocket?: WebSocket): string | null;
  eventStoreTenantForClient(client: WsClient, targetTenantId?: string, ownerUserId?: string): string | null;
  wsSend(ws: WebSocket, data: object, eventId?: number, eventCursor?: string): void;
  sendQueueSnapshot(client: WsClient, sessionId: string, recovery?: { requestId?: string; networkGeneration?: number }): Promise<void>;
  getStreamStatus(sessionId: string, tenantId?: string): Promise<{ active: boolean; streamId?: string; runId?: string; status?: string; liveness?: RunLiveness }>;
  getRuntimeEventStoreForSession(sessionId: string, tenantId: string): Promise<EventStore | null>;
}

/** Owns WebSocket runtime recovery/resume/sync protocol sequencing and replay state. */
export class WebRuntimeRecovery {
  private readonly lifecycleRecoveryLedgers = new WeakMap<WebSocket, LifecycleRecoveryRequestLedger>();

  constructor(private readonly host: RuntimeRecoveryHost) {}

  admitRequest(client: WsClient, msg: WsResumeMessage | WsSyncMessage | WsQueueSnapshotMessage | WsAttachActiveStreamMessage): boolean {
    if (!msg.requestId || msg.networkGeneration === undefined) return true;
    let ledger = this.lifecycleRecoveryLedgers.get(client.ws);
    if (!ledger) {
      ledger = new LifecycleRecoveryRequestLedger();
      this.lifecycleRecoveryLedgers.set(client.ws, ledger);
    }
    const admission = ledger.admit({ requestId: msg.requestId, networkGeneration: msg.networkGeneration });
    if (admission.status !== 'stale_generation') return true;
    this.host.wsSend(client.ws, {
      type: 'recovery_rejected',
      requestId: msg.requestId,
      reason: 'stale_network_generation',
      latestNetworkGeneration: admission.latestNetworkGeneration,
    });
    return false;
  }

  /** 处理 resume 消息（替代 GET /api/chat/stream/:sessionId） */
  handleResume(client: WsClient, msg: WsResumeMessage | WsAttachActiveStreamMessage, skipQueueSnapshot = false): void {
    // 串行化同一 ws 上的 resume，避免并发 handleResumeAsync 在 await 处交错导致
    // 双 EventBuffer listener 泄漏、每个流式事件被投递两次（详见 resumeChains 注释）。
    const ws = client.ws;
    const run = () => this.handleResumeAsync(client, msg, skipQueueSnapshot);
    const pending = this.host.resumeChains.get(ws);
    // 无在途 resume → 同步启动，保持单条 resume 的同步语义（回放/订阅在本 tick 生效）；
    // 有在途 resume → 串到其后执行，后一条一定能读到前一条已注册的订阅并先退订。
    const next = pending ? pending.then(run, run) : run();
    this.host.resumeChains.set(ws, next);
    // handleResumeAsync 内部已容错；此处仅防 unhandled rejection 断链。
    void next.catch(() => { /* noop */ });
  }

  async handleResumeAsync(client: WsClient, msg: WsResumeMessage | WsAttachActiveStreamMessage, skipQueueSnapshot: boolean): Promise<void> {
    const { sessionId: sid, requestId, networkGeneration, lastEventId, lastEventCursor, skipReplay } = msg;
    this.host.wsSessionAffinity.set(client.ws, sid);
    if (!skipQueueSnapshot) {
      await this.host.sendQueueSnapshot(client, sid, { requestId, networkGeneration }).catch((error) => {
        chatLogger.warn(`[resume] queue snapshot failed session=${sid}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const prevUnsub = this.host.resumeSubscriptions.get(client.ws);
    if (prevUnsub) {
      prevUnsub();
      this.host.resumeSubscriptions.delete(client.ws);
    }

    const bufferEntry = this.host.eventBufferStore.get(sid);
    const activeStreamId = this.host.findActiveStreamIdBySession(sid);
    const activeEntry = activeStreamId ? this.host.getActiveStream(activeStreamId) : undefined;
    const resumeBufferBoundary = bufferEntry ? bufferEntry.nextId - 1 : 0;
    // durable runStore 是判活真源；buffer 只负责传输与同进程 WS 绑定。
    let bufferActive = Boolean(bufferEntry && this.host.eventBufferStore.isActive(sid));
    let durableBinding: ResumeDurableBinding | undefined;
    if (bufferActive) {
      try {
        const runStore = this.host.config.enqueueRuntime?.runStore;
        const tenantId = this.host.eventStoreTenantForClient(client, undefined, bufferEntry?.userId);
        if (runStore?.getActiveBySession && tenantId) durableBinding = await resolveResumeDurableBinding(
          runStore.getActiveBySession.bind(runStore), tenantId, sid,
          (run) => this.host.eventStoreTenantForClient(client, run.tenantId, run.userId) ?? undefined,
        );
        if (durableBinding?.active === false) {
          this.host.eventBufferStore.complete(sid);
          bufferActive = false;
        }
      } catch (err) {
        chatLogger.warn(`[resume] runStore.getActiveBySession 异常,降级信 buffer: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!bufferEntry || !bufferActive) {
      const durableActive = await this.tryReplayDurableRuntimeEvents(client, sid, {
        requestId, networkGeneration, lastEventId, lastEventCursor, skipReplay: skipReplay === true,
      });
      if (!durableActive) this.host.wsSend(client.ws, {
        type: 'active_stream', sessionId: sid, active: false,
        ...(requestId ? { requestId } : {}),
        ...(networkGeneration !== undefined ? { networkGeneration } : {}),
      });
      const pendingAccessError = bufferEntry?.userId
        ? this.host.sensitiveActionAccessError(client, { ownerUserId: bufferEntry.userId })
        : this.host.anonymousBindingAccessError(client, activeEntry?.ws);
      if (bufferEntry && !pendingAccessError) await this.pushPendingInteractions(client, sid);
      return;
    }

    const bufferAccessError = durableBinding?.active && !durableBinding.accessError ? null
      : bufferEntry.userId ? this.host.sensitiveActionAccessError(client, { ownerUserId: bufferEntry.userId })
      : this.host.anonymousBindingAccessError(client, activeEntry?.ws);
    if (durableBinding?.accessError || bufferAccessError) {
      this.host.wsSend(client.ws, {
        type: 'active_stream', sessionId: sid, active: false,
        ...(requestId ? { requestId } : {}),
        ...(networkGeneration !== undefined ? { networkGeneration } : {}),
      });
      return;
    }
    const resumeStreamId = activeStreamId ?? durableBinding?.streamId;
    const resumeRunId = activeEntry?.runId ?? durableBinding?.runId;
    if (resumeStreamId) {
      this.host.wsActiveStream.set(client.ws, resumeStreamId);
    }

    this.host.wsSend(client.ws, {
      type: 'active_stream',
      sessionId: sid,
      active: true,
      streamId: resumeStreamId,
      ...(resumeRunId ? { runId: resumeRunId } : {}),
      status: durableBinding?.status ?? 'running',
      ...(durableBinding?.liveness ? { liveness: durableBinding.liveness } : {}),
      ...(requestId ? { requestId } : {}),
      ...(networkGeneration !== undefined ? { networkGeneration } : {}),
    });

    const alreadyDirectBound = Boolean(
      activeStreamId
      && activeEntry?.ws === client.ws
      && this.host.wsActiveStream.get(client.ws) === activeStreamId,
    );
    if (alreadyDirectBound) {
      await this.pushPendingInteractions(client, sid, durableBinding?.tenantId);
      return;
    }

    // buffer id 只在当前实例有效；durable cursor 用于跨实例增量回放。
    // 无游标时跳过全量回放，避免与客户端 transcript 快照重复。
    const hasBufferCursor = typeof lastEventId === 'number' && lastEventId > 0;
    const hasAnyCursor = hasBufferCursor || Boolean(lastEventCursor);
    if (!skipReplay && !hasAnyCursor) {
      chatLogger.warn(`[resume] replay requested without any cursor session=${sid}; skipping full replay to avoid duplicate content`);
    }
    let subscribeAfterId = resumeBufferBoundary;
    let durableReplayCursor: string | undefined;
    if (!skipReplay && hasAnyCursor) {
      if (!hasBufferCursor && lastEventCursor) {
        // The boundary was captured before async status lookup. Events pushed while either
        // status lookup or durable replay is in flight are recovered by subscribeFrom below.
        const tenantId = durableBinding?.tenantId ?? this.host.eventStoreTenantForClient(client, undefined, bufferEntry.userId) ?? undefined;
        const store = tenantId ? await this.host.getRuntimeEventStoreForSession(sid, tenantId) : null;
        if (store) {
          durableReplayCursor = await this.replayDurableRuntimeEvents(client, sid, store, {
            lastEventCursor, activeRunId: resumeRunId ?? '', tenantId,
          });
        }
      } else {
        const result = this.host.eventBufferStore.getEventsAfter(sid, lastEventId);
        subscribeAfterId = lastEventId;
        if (result) {
          if (result.gapDetected) {
            this.host.wsSend(client.ws, { type: 'buffer_overflow' });
          }
          for (const evt of result.events) {
            if (client.ws.readyState !== client.ws.OPEN) break;
            try {
              const data = JSON.parse(evt.data);
              this.host.wsSend(client.ws, data, evt.id, evt.eventCursor);
            } catch { /* skip */ }
            subscribeAfterId = evt.id;
          }
        }
      }
    }
    // Atomically recover the replay→subscribe window and subscribe to future events.
    const unsubscribe = this.host.eventBufferStore.subscribeFrom(
      sid,
      subscribeAfterId,
      (event) => {
        if (
          durableReplayCursor
          && event.eventCursor
          && isDurableCursorAtOrBefore(event.eventCursor, durableReplayCursor)
        ) return;
        if (client.ws.readyState === client.ws.OPEN) {
          try {
            const data = JSON.parse(event.data);
            this.host.wsSend(client.ws, data, event.id, event.eventCursor);
          } catch { /* skip */ }
        }
      },
      () => {
        // Agent 完成； subscribeFrom may invoke this synchronously before returning null.
        this.host.resumeSubscriptions.delete(client.ws);
      },
    );

    if (unsubscribe) {
      this.host.resumeSubscriptions.set(client.ws, unsubscribe);
    }
    // 仅首次 resume 注册 close listener（旧订阅存在说明已注册过）
    if (!prevUnsub) {
      client.ws.on('close', () => {
        const closeSub = this.host.resumeSubscriptions.get(client.ws);
        if (closeSub) { closeSub(); this.host.resumeSubscriptions.delete(client.ws); }
      });
    }

    await this.pushPendingInteractions(client, sid, durableBinding?.tenantId);
  }

  private async tryReplayDurableRuntimeEvents(
    client: WsClient,
    sessionId: string,
    options: { requestId?: string; networkGeneration?: number; lastEventId?: number; lastEventCursor?: string; skipReplay?: boolean },
  ): Promise<boolean> {
    const runStore = this.host.config.enqueueRuntime?.runStore;
    if (!runStore) return false;
    const lookupTenantId = this.host.eventStoreTenantForClient(client, undefined, this.host.eventBufferStore.get(sessionId)?.userId);
    if (!lookupTenantId) return false;
    const activeRun = await runStore.getActiveBySession?.(lookupTenantId, sessionId);
    if (!activeRun) return false;
    const active = this.host.findActiveStreamByRunId(activeRun.runId);
    const accessError = activeRun.userId || (activeRun.tenantId && activeRun.tenantId !== DEFAULT_TENANT_ID)
      ? this.host.sensitiveActionAccessError(client, { tenantId: activeRun.tenantId, ownerUserId: activeRun.userId })
      : this.host.anonymousBindingAccessError(client, active?.entry.sessionId === sessionId ? active.entry.ws : undefined);
    if (accessError) return false;
    const tenantId = this.host.eventStoreTenantForClient(client, activeRun.tenantId, activeRun.userId);
    if (!tenantId) return false;
    const streamId = typeof activeRun.metadata?.streamId === 'string' ? activeRun.metadata.streamId : activeRun.runId;
    this.host.eventBufferStore.create(sessionId, activeRun.userId);
    this.host.wsActiveStream.set(client.ws, streamId);
    this.host.wsSend(client.ws, {
      type: 'active_stream',
      sessionId,
      active: true,
      streamId,
      runId: activeRun.runId,
      status: activeRun.status,
      liveness: projectRunLiveness(activeRun),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.networkGeneration !== undefined ? { networkGeneration: options.networkGeneration } : {}),
    });
    // Capture before durable awaits so subscribeFrom recovers the replay window.
    const subscribeAfterId = this.host.eventBufferStore.get(sessionId)!.nextId - 1;
    let durableReplayCursor: string | undefined;
    if (!options.skipReplay) {
      const store = await this.host.getRuntimeEventStoreForSession(sessionId, tenantId);
      if (store) {
        durableReplayCursor = await this.replayDurableRuntimeEvents(client, sessionId, store, {
          ...options, activeRunId: activeRun.runId, tenantId,
        });
      }
    }
    const unsubscribe = this.host.eventBufferStore.subscribeFrom(
      sessionId,
      subscribeAfterId,
      (event) => {
        if (
          durableReplayCursor
          && event.eventCursor
          && isDurableCursorAtOrBefore(event.eventCursor, durableReplayCursor)
        ) return;
        if (client.ws.readyState === client.ws.OPEN) {
          try { this.host.wsSend(client.ws, JSON.parse(event.data), event.id, event.eventCursor); } catch { /* skip */ }
        }
      },
      () => {
        // subscribeFrom may complete synchronously and return null; never install a noop.
        this.host.resumeSubscriptions.delete(client.ws);
      },
    );
    if (unsubscribe) this.host.resumeSubscriptions.set(client.ws, unsubscribe);
    client.ws.once('close', () => {
      const closeSub = this.host.resumeSubscriptions.get(client.ws);
      if (closeSub) { closeSub(); this.host.resumeSubscriptions.delete(client.ws); }
    });
    await this.pushPendingInteractions(client, sessionId, tenantId);
    return true;
  }

  async getRuntimeEventStoreForSession(sessionId: string, tenantId: string): Promise<EventStore | null> {
    if (!this.host.config.runtimeEventStoreFor) return null;
    const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
    return this.host.config.runtimeEventStoreFor(transcriptPath ?? '', tenantId);
  }

  async replayDurableRuntimeEvents(
    client: WsClient,
    sessionId: string, store: EventStore,
    options: { lastEventId?: number; lastEventCursor?: string; activeRunId: string; tenantId?: string },
  ): Promise<string | undefined> {
    const tenantId = options.tenantId ?? this.host.eventStoreTenantForClient(client); if (!tenantId) return undefined;
    let replayId = options.lastEventId ?? 0;
    let replayedCursor = options.lastEventCursor;
    const hasDurableCursor = Boolean(options.lastEventCursor);
    const streamStates = new Map<string, RuntimeStreamProjectionState>();
    // ws-only 接管时预热 cursor 前的投影状态，但不重发已在 DOM 的 batch。
    if (hasDurableCursor && options.lastEventCursor && store.listByRun) {
      const priorRunEvents = await store.listByRun(tenantId, sessionId, options.activeRunId);
      for (const event of priorRunEvents) {
        if (event.type !== 'assistant_stream_event') continue;
        const eventCursor = getDurableEventCursor(event);
        if (!eventCursor || !isDurableCursorAtOrBefore(eventCursor, options.lastEventCursor)) continue;
        projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates });
      }
    }
    if (store.listPage) {
      let cursor: string | undefined = hasDurableCursor ? options.lastEventCursor : undefined;
      while (true) {
        const page = await store.listPage(tenantId, sessionId, {
          afterCursor: cursor,
          limit: 200,
          // durable cursor 是会话级游标；没有游标时绝不能从会话开头回放，
          // 否则重连会把历次 Agent 回复全部追加到当前消息流。
          ...(!hasDurableCursor ? { runId: options.activeRunId } : {}),
        });
        for (const event of page.events) {
          const eventCursor = getDurableEventCursor(event);
          const frames = projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates }).events;
          for (const [index, data] of frames.entries()) {
            replayId += 1;
            const frameCursor = index === frames.length - 1 ? eventCursor : undefined;
            // replayId is synthetic, not an EventBuffer ID. Once the client has a durable
            // cursor, attaching replayId would let a later resume accidentally enter the
            // in-memory buffer-cursor path.
            this.host.wsSend(client.ws, data, hasDurableCursor ? undefined : replayId, frameCursor);
          }
          // Do not cover buffered events with this cursor until every projected frame sent.
          if (eventCursor) replayedCursor = eventCursor;
        }
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return replayedCursor;
    }
    // 兼容没有分页能力的自定义 EventStore，同样把最坏影响限制在当前 run。
    const events = store.listByRun
      ? await store.listByRun(tenantId, sessionId, options.activeRunId)
      : (await store.list(tenantId, sessionId)).filter(
          (event) => 'runId' in event && event.runId === options.activeRunId,
        );
    for (const event of events) {
      const eventCursor = getDurableEventCursor(event);
      const frames = projectRuntimePlatformEvent(event, { expandStreamed: true, streamStates }).events;
      for (const [index, data] of frames.entries()) {
        replayId += 1;
        const frameCursor = index === frames.length - 1 ? eventCursor : undefined;
        if (replayId > (options.lastEventId ?? 0)) {
          this.host.wsSend(client.ws, data, hasDurableCursor ? undefined : replayId, frameCursor);
        }
      }
      if (eventCursor) replayedCursor = eventCursor;
    }
    return replayedCursor;
  }

  /** 处理 detach 消息：后台/切换会话时仅解绑传输，不取消已有 run。 */
  handleDetach(client: WsClient): void {
    // 清除 WS 活跃流绑定，阻止旧会话的 handleEvents/hooks send 继续向此 WS 直接推送
    this.host.wsActiveStream.delete(client.ws);
    this.host.wsSessionAffinity.delete(client.ws);
    const prevUnsub = this.host.resumeSubscriptions.get(client.ws);
    if (prevUnsub) {
      prevUnsub();
      this.host.resumeSubscriptions.delete(client.ws);
    }
  }

  /** 处理 sync 消息：断线重连时回放漏掉的元数据事件。 */
  async handleSync(client: WsClient, msg: WsSyncMessage): Promise<void> {
    const userId = client.user?.sub;
    const wsServer = this.host.getWsServer();
    if (!userId || !wsServer) return;

    const eventLog = wsServer.userEventLog;
    const epoch = eventLog.getEpoch(userId);
    const currentSeq = eventLog.getCurrentSeq(userId);
    const correlation = {
      ...(msg.requestId ? { requestId: msg.requestId } : {}),
      ...(msg.networkGeneration !== undefined ? { networkGeneration: msg.networkGeneration } : {}),
    };
    if (wsServer.hasUserEventEpochMismatch(client, userId, msg.epoch, msg.lastSeq)) {
      this.host.wsSend(client.ws, {
        ...buildSyncOverflowFrame(
          currentSeq,
          epoch,
          await this.buildAuthoritativeSyncSessionSnapshot(client, msg.sessionId),
        ),
        ...correlation,
      });
      return;
    }

    const result = eventLog.getEventsAfter(userId, msg.lastSeq);
    if (result.gapDetected) {
      this.host.wsSend(client.ws, {
        ...buildSyncOverflowFrame(
          currentSeq,
          epoch,
          await this.buildAuthoritativeSyncSessionSnapshot(client, msg.sessionId),
        ),
        ...correlation,
      });
    } else {
      this.host.wsSend(client.ws, {
        type: 'sync_ok',
        seq: currentSeq,
        epoch,
        events: result.events,
        ...correlation,
      });
    }
  }

  private async buildAuthoritativeSyncSessionSnapshot(
    client: WsClient,
    requestedSessionId?: string,
  ): Promise<SyncSessionSnapshot | undefined> {
    const sessionId = requestedSessionId ?? this.host.wsSessionAffinity.get(client.ws);
    if (!sessionId) return undefined;
    const snapshot: SyncSessionSnapshot = { sessionId };
    const runStore = this.host.config.enqueueRuntime?.runStore;
    const tenantId = client.user?.tenantId;
    if (runStore?.listUserMessagesBySession) {
      const runs = await runStore.listUserMessagesBySession(sessionId, tenantId);
      const first = runs[0];
      if (first && this.host.sensitiveActionAccessError(client, {
        tenantId: first.tenantId,
        ownerUserId: first.userId,
      })) return undefined;
      snapshot.queueSnapshot = buildChatQueueSnapshot(sessionId, runs);
    }
    snapshot.runtime = await this.host.getStreamStatus(sessionId, tenantId);
    snapshot.pendingInteractions = await this.getAuthoritativePendingInteractions(
      client,
      sessionId,
      tenantId,
    );
    return snapshot;
  }

  private async getAuthoritativePendingInteractions(
    client: WsClient,
    sessionId: string,
    tenantId?: string,
  ): Promise<SyncPendingInteractionSnapshot[]> {
    const pending = interactionStore.getPendingInteractions(sessionId);
    const ownerIds = new Set(pending.map((entry) => interactionStore.get(entry.interactionId)?.userId).filter((id): id is string => Boolean(id)));
    if (ownerIds.size > 1) return [];
    const ownerUserId = this.host.eventBufferStore.get(sessionId)?.userId ?? ownerIds.values().next().value;
    const scopedTenantId = tenantId ?? this.host.eventStoreTenantForClient(client, undefined, ownerUserId) ?? undefined;
    if (this.host.config.runtimeEventStoreFor && !scopedTenantId) return [];
    const resolvedIds = this.host.config.runtimeEventStoreFor ? await loadResolvedInteractionIds(await this.host.getRuntimeEventStoreForSession(sessionId, scopedTenantId!), scopedTenantId!, sessionId) : new Set<string>();
    const unresolved = pending.filter((entry) => !resolvedIds.has(entry.interactionId));
    const excluded = new Set([...resolvedIds, ...unresolved.map((entry) => entry.interactionId)]);

    const recovered = scanBufferForPendingInteractions(this.host.eventBufferStore.getEventsAfter(sessionId, 0)?.events, excluded);
    if (recovered.length > 0) unresolved.push(...recovered);
    return unresolved;
  }

  async pushPendingInteractions(client: WsClient, sessionId: string, tenantId?: string): Promise<void> {
    const unresolved = await this.getAuthoritativePendingInteractions(client, sessionId, tenantId);
    // Resume preserves N-1 frame ordering when empty; sync snapshots still carry authoritative [].
    if (unresolved.length > 0) this.host.wsSend(client.ws, { type: 'pending_interactions', sessionId, interactions: unresolved });
  }

}

/** Keep the durable run alive while releasing connection-scoped recovery state. */
export function handleRuntimeStreamSocketClose(
  activeStreamWebSocket: WebSocket | undefined,
  ws: WebSocket,
  wsActiveStream: WeakMap<WebSocket, string>,
  connectionAbortController: AbortController,
  activeInteractionIds: Set<string>,
): void {
  if (activeStreamWebSocket === ws) wsActiveStream.delete(ws);
  connectionAbortController.abort();
  interactionStore.rejectOnDisconnect(activeInteractionIds, 'WebSocket connection closed');
}

/** Resolve durable run liveness first, falling back to the in-process transport buffer. */
export async function getRuntimeStreamStatus(
  sessionId: string,
  runStore: RunStore | undefined,
  eventBufferStore: EventBufferStore,
  findActiveStreamIdBySession: (sessionId: string) => string | undefined,
  tenantId?: string,
): Promise<{ active: boolean; streamId?: string; runId?: string; status?: string; liveness?: RunLiveness }> {
  try {
    if (runStore?.getActiveBySession && tenantId) {
      const activeRun = await runStore.getActiveBySession(tenantId, sessionId);
      if (activeRun) {
        const streamId = findActiveStreamIdBySession(sessionId)
          ?? (typeof activeRun.metadata?.streamId === 'string' ? activeRun.metadata.streamId : undefined);
        return {
          active: true,
          ...(streamId ? { streamId } : {}),
          runId: activeRun.runId,
          status: activeRun.status,
          liveness: projectRunLiveness(activeRun),
        };
      }
      return { active: false };
    }
  } catch (error) {
    chatLogger.warn(`[stream-status] runStore.getActiveBySession 异常,降级查 buffer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!eventBufferStore.isActive(sessionId)) return { active: false };
  const streamId = findActiveStreamIdBySession(sessionId);
  return { active: true, ...(streamId ? { streamId } : {}) };
}

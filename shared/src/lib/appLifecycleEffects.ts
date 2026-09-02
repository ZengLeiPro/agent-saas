import type { CanonicalLifecycleEffect } from './appLifecycle';
import type { WsOutboundMessage } from './wsClient';

export interface CanonicalLifecycleEffectDependencies {
  recoverAuthJournal(): void | Promise<void>;
  probeReachability(): boolean | Promise<boolean>;
  connectWsAuth(): void | Promise<void>;
  sendWs(message: WsOutboundMessage): boolean;
  syncCursor(): { lastSeq: number; epoch?: string; sessionId?: string };
  activeSession(): { sessionId: string; lastEventId: number; lastEventCursor?: string | null } | null;
  restoreInteractions(): void | Promise<void>;
  stopRecording(): void | Promise<void>;
  stopTts(): void | Promise<void>;
  pauseNonEssentialUploads(): void | Promise<void>;
  pauseHeartbeatAndPolling(): void | Promise<void>;
  closeWs(): void | Promise<void>;
}

export interface CanonicalLifecycleEffectResult {
  effectId: string;
  succeeded: boolean;
  retryable?: boolean;
}

/** Executes the machine's sole effect against existing auth/WS/queue/runtime/voice authorities. */
export async function executeCanonicalLifecycleEffect(
  effect: CanonicalLifecycleEffect,
  dependencies: CanonicalLifecycleEffectDependencies,
): Promise<CanonicalLifecycleEffectResult> {
  const requestId = effect.requestId;
  const networkGeneration = effect.fence.networkGeneration;
  try {
    switch (effect.kind) {
      case 'suspend_nonessential':
        await Promise.all([
          dependencies.stopRecording(),
          dependencies.stopTts(),
          dependencies.pauseNonEssentialUploads(),
          dependencies.pauseHeartbeatAndPolling(),
        ]);
        break;
      case 'detach_background':
        dependencies.sendWs({ action: 'detach' });
        await dependencies.closeWs();
        break;
      case 'recover_auth_journal':
        await dependencies.recoverAuthJournal();
        break;
      case 'probe_reachability':
        if (await dependencies.probeReachability() !== true) throw new Error('INTERNET_NOT_REACHABLE');
        break;
      case 'connect_ws_auth':
        await dependencies.connectWsAuth();
        break;
      case 'sync_seq_epoch': {
        const cursor = dependencies.syncCursor();
        if (!requestId || !dependencies.sendWs({
          action: 'sync', lastSeq: cursor.lastSeq, ...(cursor.epoch ? { epoch: cursor.epoch } : {}),
          ...(cursor.sessionId ? { sessionId: cursor.sessionId } : {}), requestId, networkGeneration,
        })) throw new Error('SYNC_NOT_SENT');
        break;
      }
      case 'fetch_queue_snapshot': {
        const active = dependencies.activeSession();
        if (!active || !requestId || !dependencies.sendWs({
          action: 'queue_snapshot', sessionId: active.sessionId, requestId, networkGeneration,
        })) throw new Error('QUEUE_SNAPSHOT_NOT_SENT');
        break;
      }
      case 'attach_active_stream': {
        const active = dependencies.activeSession();
        if (!active || !requestId || !dependencies.sendWs({
          action: 'attach_active_stream', sessionId: active.sessionId, requestId, networkGeneration,
          lastEventId: active.lastEventId,
          ...(active.lastEventCursor ? { lastEventCursor: active.lastEventCursor } : {}),
        })) throw new Error('ATTACH_NOT_SENT');
        break;
      }
      case 'restore_interactions':
        await dependencies.restoreInteractions();
        break;
    }
    return { effectId: effect.id, succeeded: true };
  } catch {
    return { effectId: effect.id, succeeded: false, retryable: true };
  }
}

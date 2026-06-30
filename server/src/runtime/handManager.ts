import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { ExecutionTransport, ExecutionTransportRegistry } from './executionTransport.js';
import type { EventStore } from './types.js';
import type { HandRecord, HandStore, RegisterHandInput, WorkspaceRecipe } from './handStore.js';

export interface HandHealth {
  status: 'ok' | 'unhealthy';
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface HandManagerOptions {
  handStore: HandStore;
  transportRegistry: ExecutionTransportRegistry;
  eventStore?: EventStore;
  healthCheck?: (hand: HandRecord) => Promise<HandHealth>;
}

export class HandManager {
  constructor(private readonly options: HandManagerOptions) {}

  async provision(input: RegisterHandInput & { recipe?: WorkspaceRecipe }): Promise<HandRecord> {
    const record = await this.options.handStore.register({
      ...input,
      metadata: { ...(input.metadata ?? {}), ...(input.recipe ? { recipe: input.recipe } : {}) },
    });
    if (record.sessionId) {
      await this.options.eventStore?.append({
        type: 'hand_provisioned',
        sessionId: record.sessionId,
        handId: record.handId,
        workspaceId: record.workspaceId,
        handType: record.type,
        status: record.status,
      });
    }
    return record;
  }

  list(sessionId: string): Promise<HandRecord[]> {
    return this.options.handStore.listBySession(sessionId);
  }

  async health(handId: string): Promise<HandHealth> {
    const hand = await this.options.handStore.get(handId);
    if (!hand) return { status: 'unhealthy', detail: `hand not found: ${handId}` };
    const health = this.options.healthCheck
      ? await this.options.healthCheck(hand)
      : { status: hand.status === 'ready' ? 'ok' as const : 'unhealthy' as const, detail: hand.status };
    const nextStatus = health.status === 'ok' ? 'ready' : 'unhealthy';
    if (hand.status !== nextStatus) {
      await this.options.handStore.updateStatus(handId, nextStatus, { lastHealth: health });
      if (hand.sessionId) {
        await this.options.eventStore?.append({
          type: 'hand_health_changed',
          sessionId: hand.sessionId,
          handId: hand.handId,
          workspaceId: hand.workspaceId,
          status: nextStatus,
          detail: health.detail,
        });
      }
    }
    return health;
  }

  async destroy(handId: string, reason?: string): Promise<HandRecord | null> {
    const record = await this.options.handStore.updateStatus(handId, 'destroyed', reason ? { destroyReason: reason } : {});
    if (record) {
      if (record.sessionId) {
        await this.options.eventStore?.append({
          type: 'hand_destroyed',
          sessionId: record.sessionId,
          handId: record.handId,
          workspaceId: record.workspaceId,
          reason,
        });
      }
    }
    return record;
  }

  resolveTransport(args: { handId?: string; capability?: string; executionTarget?: ExecutionTargetKind }): ExecutionTransport {
    if (args.executionTarget) return this.options.transportRegistry.get(args.executionTarget);
    throw new Error(`hand/capability transport resolution requires executionTarget compatibility fallback today (handId=${args.handId ?? '-'}, capability=${args.capability ?? '-'})`);
  }
}

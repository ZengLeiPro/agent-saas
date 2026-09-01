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
  /** Authoritative session tenant supplied by runtime dispatch. */
  tenantId: string;
  healthCheck?: (hand: HandRecord) => Promise<HandHealth>;
}

function requireHandEventTenant(hand: HandRecord, configuredTenantId?: string): string {
  const recordTenantId = hand.tenantId?.trim();
  const expectedTenantId = configuredTenantId?.trim();
  if (recordTenantId && expectedTenantId && recordTenantId !== expectedTenantId) {
    throw new Error(`Hand tenant mismatch for ${hand.handId}`);
  }
  const tenantId = recordTenantId ?? expectedTenantId;
  if (!tenantId) throw new Error(`Hand tenant is missing for ${hand.handId}`);
  return tenantId;
}

export class HandManager {
  constructor(private readonly options: HandManagerOptions) {}

  async provision(input: RegisterHandInput & { recipe?: WorkspaceRecipe }): Promise<HandRecord> {
    const record = await this.options.handStore.register({
      ...input,
      tenantId: this.options.tenantId,
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
      }, { tenantId: requireHandEventTenant(record, this.options.tenantId) });
    }
    return record;
  }

  list(sessionId: string): Promise<HandRecord[]> {
    return this.options.handStore.listBySession(sessionId, this.options.tenantId);
  }

  async health(handId: string): Promise<HandHealth> {
    const hand = await this.options.handStore.get(handId, this.options.tenantId);
    if (!hand) return { status: 'unhealthy', detail: `hand not found: ${handId}` };
    const health = this.options.healthCheck
      ? await this.options.healthCheck(hand)
      : { status: hand.status === 'ready' ? 'ok' as const : 'unhealthy' as const, detail: hand.status };
    const nextStatus = health.status === 'ok' ? 'ready' : 'unhealthy';
    if (hand.status !== nextStatus) {
      await this.options.handStore.updateStatus(handId, nextStatus, { lastHealth: health }, this.options.tenantId);
      if (hand.sessionId) {
        await this.options.eventStore?.append({
          type: 'hand_health_changed',
          sessionId: hand.sessionId,
          handId: hand.handId,
          workspaceId: hand.workspaceId,
          status: nextStatus,
          detail: health.detail,
        }, { tenantId: requireHandEventTenant(hand, this.options.tenantId) });
      }
    }
    return health;
  }

  async destroy(handId: string, reason?: string): Promise<HandRecord | null> {
    const record = await this.options.handStore.updateStatus(handId, 'destroyed', reason ? { destroyReason: reason } : {}, this.options.tenantId);
    if (record) {
      if (record.sessionId) {
        await this.options.eventStore?.append({
          type: 'hand_destroyed',
          sessionId: record.sessionId,
          handId: record.handId,
          workspaceId: record.workspaceId,
          reason,
        }, { tenantId: requireHandEventTenant(record, this.options.tenantId) });
      }
    }
    return record;
  }

  resolveTransport(args: { handId?: string; capability?: string; executionTarget?: ExecutionTargetKind }): ExecutionTransport {
    if (args.executionTarget) return this.options.transportRegistry.get(args.executionTarget);
    throw new Error(`hand/capability transport resolution requires executionTarget compatibility fallback today (handId=${args.handId ?? '-'}, capability=${args.capability ?? '-'})`);
  }
}

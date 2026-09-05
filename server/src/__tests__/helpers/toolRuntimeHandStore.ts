import type {
  HandRecord,
  HandStore,
  HandStatus,
  RegisterHandInput,
} from '../../runtime/handStore.js';

export class MemoryHandStore implements HandStore {
  constructor(private readonly hands: HandRecord[]) {}
  async register(_input: RegisterHandInput): Promise<HandRecord> {
    throw new Error('not implemented');
  }
  async updateStatus(handId: string, status: HandStatus): Promise<HandRecord | null> {
    const hand = this.hands.find((item) => item.handId === handId);
    if (!hand) return null;
    hand.status = status;
    hand.updatedAt = new Date().toISOString();
    return hand;
  }
  async claimProvisionRecovery(): Promise<HandRecord | null> {
    return null;
  }
  async completeProvisionAttempt(): Promise<HandRecord | null> {
    return null;
  }
  async completeProvisionRecovery(): Promise<HandRecord | null> {
    return null;
  }
  async get(handId: string): Promise<HandRecord | null> {
    return this.hands.find((hand) => hand.handId === handId) ?? null;
  }
  async listBySession(sessionId: string): Promise<HandRecord[]> {
    return this.hands.filter((hand) => hand.sessionId === sessionId);
  }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> {
    return this.hands.filter((hand) => hand.workspaceId === workspaceId);
  }
}

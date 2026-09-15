import type { PlatformDemoSessionDraft } from './types.js';
import { platformDemoSessionKey } from './types.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlatformDemoSessionStore {
  get(actorUserId: string, actorTenantId: string, sectionId: string, now?: Date): Promise<PlatformDemoSessionDraft | null>;
  save(input: {
    actorUserId: string;
    actorTenantId: string;
    sectionId: string;
    draft: Record<string, unknown>;
    now?: Date;
    ttlMs?: number;
  }): Promise<PlatformDemoSessionDraft>;
  clearExpired(now?: Date): Promise<number>;
}

export class InMemoryPlatformDemoSessionStore implements PlatformDemoSessionStore {
  private readonly drafts = new Map<string, PlatformDemoSessionDraft>();

  async get(
    actorUserId: string,
    actorTenantId: string,
    sectionId: string,
    now: Date = new Date(),
  ): Promise<PlatformDemoSessionDraft | null> {
    const key = platformDemoSessionKey(actorUserId, actorTenantId, sectionId);
    const draft = this.drafts.get(key);
    if (!draft) return null;
    if (Date.parse(draft.expiresAt) <= now.getTime()) {
      this.drafts.delete(key);
      return null;
    }
    if (draft.actorUserId !== actorUserId || draft.actorTenantId !== actorTenantId) {
      return null;
    }
    return { ...draft, draft: { ...draft.draft } };
  }

  async save(input: {
    actorUserId: string;
    actorTenantId: string;
    sectionId: string;
    draft: Record<string, unknown>;
    now?: Date;
    ttlMs?: number;
  }): Promise<PlatformDemoSessionDraft> {
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const sessionKey = platformDemoSessionKey(input.actorUserId, input.actorTenantId, input.sectionId);
    const next: PlatformDemoSessionDraft = {
      sessionKey,
      actorUserId: input.actorUserId,
      actorTenantId: input.actorTenantId,
      sectionId: input.sectionId,
      draft: { ...input.draft },
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.drafts.set(sessionKey, next);
    return { ...next, draft: { ...next.draft } };
  }

  async clearExpired(now: Date = new Date()): Promise<number> {
    let removed = 0;
    for (const [key, draft] of this.drafts) {
      if (Date.parse(draft.expiresAt) <= now.getTime()) {
        this.drafts.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

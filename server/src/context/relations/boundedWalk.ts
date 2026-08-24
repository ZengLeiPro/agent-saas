import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  RelationEdgeCandidate,
  RelationReadStore,
  RelationWalkCandidate,
  RelationWalkInput,
  RelationWalkPage,
} from './types.js';

const MAX_PAGE_SIZE = 50;
const MAX_CANDIDATES = 200;
const ID_PATTERN = /^[^\u0000]{1,500}$/;

export class RelationWalkError extends Error {
  constructor(readonly code: 'RELATION_WALK_INVALID' | 'RELATION_CURSOR_INVALID') {
    super(code);
    this.name = 'RelationWalkError';
  }
}

interface CursorPayload {
  v: 1;
  fingerprint: string;
  offset: number;
}

/** Bounded candidate traversal. Authorization must be applied above this layer. */
export class BoundedRelationWalkService {
  private readonly signingKey: Buffer;

  constructor(private readonly store: RelationReadStore, signingKey: string | Buffer) {
    this.signingKey = Buffer.isBuffer(signingKey) ? Buffer.from(signingKey) : Buffer.from(signingKey, 'utf8');
    if (this.signingKey.length < 32) throw new RelationWalkError('RELATION_WALK_INVALID');
  }

  async walk(input: RelationWalkInput): Promise<RelationWalkPage> {
    const pageSize = input.pageSize ?? 25;
    const candidateLimit = input.candidateLimit ?? 100;
    validateWalk(input, pageSize, candidateLimit);
    const fingerprint = requestFingerprint(input, pageSize, candidateLimit, this.signingKey);
    const offset = input.cursor ? this.decodeCursor(input.cursor, fingerprint).offset : 0;

    const visited = new Set<string>([input.startEntityId]);
    let frontier = new Set<string>([input.startEntityId]);
    const candidates: RelationWalkCandidate[] = [];
    let bounded = false;

    for (let depth = 1 as 1 | 2; depth <= input.maxDepth && frontier.size > 0; depth = (depth + 1) as 1 | 2) {
      const remaining = candidateLimit - candidates.length;
      if (remaining <= 0) { bounded = true; break; }
      const edges = await this.store.listAdjacent({
        tenantId: input.tenantId,
        entityIds: [...frontier].sort(),
        limit: Math.min(500, remaining + 1),
      });
      if (edges.length > remaining) bounded = true;
      const nextFrontier = new Set<string>();
      for (const edge of [...edges].sort(compareEdges)) {
        if (candidates.length >= candidateLimit) { bounded = true; break; }
        const step = nextStep(edge, frontier);
        if (!step || visited.has(step.nextEntityId)) continue;
        visited.add(step.nextEntityId);
        nextFrontier.add(step.nextEntityId);
        candidates.push({ depth, fromEntityId: step.fromEntityId, nextEntityId: step.nextEntityId, edge });
      }
      frontier = nextFrontier;
    }

    if (offset < 0 || offset > candidates.length) throw new RelationWalkError('RELATION_CURSOR_INVALID');
    const page = candidates.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      candidates: page,
      ...(nextOffset < candidates.length ? { nextCursor: this.encodeCursor({ v: 1, fingerprint, offset: nextOffset }) } : {}),
      truncated: bounded,
      authorization: 'unchecked',
    };
  }

  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${sign(encoded, this.signingKey)}`;
  }

  private decodeCursor(cursor: string, fingerprint: string): CursorPayload {
    if (cursor.length > 2_000) throw new RelationWalkError('RELATION_CURSOR_INVALID');
    const [encoded, signature, extra] = cursor.split('.');
    if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded, this.signingKey))) {
      throw new RelationWalkError('RELATION_CURSOR_INVALID');
    }
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CursorPayload>;
      if (value.v !== 1 || value.fingerprint !== fingerprint || !Number.isInteger(value.offset) || value.offset! < 0) {
        throw new RelationWalkError('RELATION_CURSOR_INVALID');
      }
      return value as CursorPayload;
    } catch (error) {
      if (error instanceof RelationWalkError) throw error;
      throw new RelationWalkError('RELATION_CURSOR_INVALID');
    }
  }
}

function validateWalk(input: RelationWalkInput, pageSize: number, candidateLimit: number): void {
  if (!ID_PATTERN.test(input.tenantId) || !ID_PATTERN.test(input.startEntityId)
    || (input.maxDepth !== 1 && input.maxDepth !== 2)
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE
    || !Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > MAX_CANDIDATES) {
    throw new RelationWalkError('RELATION_WALK_INVALID');
  }
}

function nextStep(edge: RelationEdgeCandidate, frontier: Set<string>): { fromEntityId: string; nextEntityId: string } | undefined {
  if (frontier.has(edge.from.entityId)) return { fromEntityId: edge.from.entityId, nextEntityId: edge.to.entityId };
  if (frontier.has(edge.to.entityId)) return { fromEntityId: edge.to.entityId, nextEntityId: edge.from.entityId };
  return undefined;
}

function compareEdges(left: RelationEdgeCandidate, right: RelationEdgeCandidate): number {
  return left.relationId.localeCompare(right.relationId)
    || left.from.entityId.localeCompare(right.from.entityId)
    || left.to.entityId.localeCompare(right.to.entityId);
}

function requestFingerprint(input: RelationWalkInput, pageSize: number, candidateLimit: number, key: Buffer): string {
  return createHmac('sha256', key).update(JSON.stringify({
    tenantId: input.tenantId, startEntityId: input.startEntityId,
    maxDepth: input.maxDepth, pageSize, candidateLimit,
  })).digest('base64url');
}

function sign(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(`context-relation-walk:${value}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Event Buffer Store
 *
 * Per-session ring buffer for SSE events. Supports:
 * - Incremental event IDs for SSE `id:` field
 * - Buffering events even after SSE disconnect (Agent continues running)
 * - Replay missed events for reconnection
 * - Pub/sub for live event forwarding to reconnected clients
 */

export interface BufferedEvent {
  id: number;
  data: string;
  timestamp: number;
  eventCursor?: string;
}

type EventListener = (event: BufferedEvent) => void;
type CompletionListener = () => void;

interface EventBufferEntry {
  events: BufferedEvent[];
  nextId: number;
  /** Lowest event ID still in buffer (tracks evictions for gap detection) */
  oldestId: number;
  completed: boolean;
  completedAt: number | null;
  userId?: string;
  listeners: Set<EventListener>;
  completionListeners: Set<CompletionListener>;
}

/** Max events per session buffer (~400KB per run, 10 concurrent ~4MB) */
const MAX_EVENTS = 2000;
/** How long to keep completed buffers (15 minutes) */
const BUFFER_TTL_MS = 15 * 60 * 1000;
/** Cleanup scan interval */
const CLEANUP_INTERVAL_MS = 60 * 1000;

export class EventBufferStore {
  private buffers = new Map<string, EventBufferEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Create a new buffer for a session */
  create(sessionId: string, userId?: string): void {
    const existing = this.buffers.get(sessionId);
    if (existing && !existing.completed) {
      if (userId && !existing.userId) existing.userId = userId;
      return;
    }

    this.buffers.set(sessionId, {
      events: [],
      nextId: 1,
      oldestId: 1,
      completed: false,
      completedAt: null,
      userId,
      listeners: new Set(),
      completionListeners: new Set(),
    });
  }

  /** Get a buffer entry (for access control checks) */
  get(sessionId: string): EventBufferEntry | undefined {
    return this.buffers.get(sessionId);
  }

  /** Push an event into the buffer, return its ID */
  push(sessionId: string, jsonData: string, eventCursor?: string): number | null {
    const entry = this.buffers.get(sessionId);
    if (!entry) return null;

    const event: BufferedEvent = {
      id: entry.nextId++,
      data: jsonData,
      timestamp: Date.now(),
      ...(eventCursor ? { eventCursor } : {}),
    };

    // Ring buffer: evict oldest when full
    if (entry.events.length >= MAX_EVENTS) {
      const evicted = entry.events.shift();
      if (evicted) {
        entry.oldestId = evicted.id + 1;
      }
    }
    entry.events.push(event);

    // Notify live subscribers
    for (const listener of entry.listeners) {
      try { listener(event); } catch { /* silent */ }
    }

    return event.id;
  }

  /** Get all events after the given ID.
   *  Returns { events, gapDetected } where gapDetected=true means some events
   *  were evicted from the ring buffer and cannot be replayed. */
  getEventsAfter(sessionId: string, lastId: number): { events: BufferedEvent[]; gapDetected: boolean } | null {
    const entry = this.buffers.get(sessionId);
    if (!entry) return null;

    // If the requested lastId is older than our oldest buffered event,
    // some events were evicted and the client has a gap.
    const gapDetected = lastId > 0 && lastId < entry.oldestId - 1;

    const startIdx = entry.events.findIndex(e => e.id > lastId);
    if (startIdx === -1) return { events: [], gapDetected };
    return { events: entry.events.slice(startIdx), gapDetected };
  }

  /** Check if the session's Agent is still running */
  isActive(sessionId: string): boolean {
    const entry = this.buffers.get(sessionId);
    return !!entry && !entry.completed;
  }

  /** Mark session as completed, notify completion subscribers */
  complete(sessionId: string): void {
    const entry = this.buffers.get(sessionId);
    if (!entry) return;

    entry.completed = true;
    entry.completedAt = Date.now();

    for (const listener of entry.completionListeners) {
      try { listener(); } catch { /* silent */ }
    }
    // Clear listeners after completion
    entry.listeners.clear();
    entry.completionListeners.clear();
  }

  /** Subscribe to new events and completion for a session.
   *  Returns an unsubscribe function. */
  subscribe(
    sessionId: string,
    onEvent: EventListener,
    onComplete: CompletionListener,
  ): (() => void) | null {
    const entry = this.buffers.get(sessionId);
    if (!entry) return null;

    entry.listeners.add(onEvent);
    entry.completionListeners.add(onComplete);

    return () => {
      entry.listeners.delete(onEvent);
      entry.completionListeners.delete(onComplete);
    };
  }

  /** Immediately drop a single session's buffer (used for phantom-session rollback) */
  remove(sessionId: string): void {
    const entry = this.buffers.get(sessionId);
    if (!entry) return;
    entry.listeners.clear();
    entry.completionListeners.clear();
    this.buffers.delete(sessionId);
  }

  /** Remove expired completed buffers */
  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.buffers) {
      if (entry.completed && entry.completedAt && now - entry.completedAt > BUFFER_TTL_MS) {
        this.buffers.delete(sessionId);
      }
    }
  }

  /** Stop cleanup timer */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buffers.clear();
  }
}

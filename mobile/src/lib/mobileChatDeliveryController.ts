import {
  MessageStatusProbePool, MESSAGE_STATUS_BUDGET_MS,
  type AcceptedMessageStatus, type CanonicalChatSubmission, type MessageItem,
  type MessageStatusFetch, type MessageStatusResult,
} from '@agent/shared';
import {
  copyCanonicalSubmission, dedupeDeliveryBubbles, deliveryPresentation, MOBILE_ACK_DEADLINE_MS,
  MOBILE_CONNECT_DEADLINE_MS, ownsDeliveryView, projectDeliveryBubble,
  sameMobileDeliveryFence, type DeliveryBubble, type MobileAcceptanceEvidence,
  type MobileDeliveryAttempt, type MobileDeliveryFence, type MobileDeliveryOwner,
  type MobileDeliveryView, type MobileSubmissionRecord,
} from './mobileChatDeliveryState';

export type MobileVerifyResult = MessageStatusResult | { kind: 'already_accepted' | 'rejected' };
export interface MobileDeliveryControllerOptions {
  fence: MobileDeliveryFence;
  currentFence: () => MobileDeliveryFence | null;
  canRead: () => boolean;
  request?: MessageStatusFetch;
  onChange: (record: MobileSubmissionRecord) => void;
  onAccepted: (record: MobileSubmissionRecord, evidence: MobileAcceptanceEvidence) => void;
  mergeStatus: (value: AcceptedMessageStatus) => MobileAcceptanceEvidence;
  trace?: (stage: string, record: MobileSubmissionRecord) => void;
}

/** Local delivery observations replace the old outbox/timer pair. Never dispatches chat itself. */
export class MobileChatDeliveryController {
  private readonly entries = new Map<string, MobileSubmissionRecord>();
  private probes: MessageStatusProbePool;
  private readonly verifications = new Map<string, Promise<MobileVerifyResult>>();
  private serial = 0;
  private disposed = false;
  constructor(private readonly options: MobileDeliveryControllerOptions) {
    this.probes = new MessageStatusProbePool(options.request);
  }
  isCurrent(): boolean { return !this.disposed && sameMobileDeliveryFence(this.options.fence, this.options.currentFence()); }
  get(clientMsgId: string): MobileSubmissionRecord | undefined { return this.entries.get(clientMsgId); }
  records(): readonly MobileSubmissionRecord[] { return [...this.entries.values()]; }
  hasPending(view: MobileDeliveryView): boolean {
    return this.records().some(record => ownsDeliveryView(record, view) && record.fact.kind === 'unconfirmed'
      && record.attempt.phase.kind !== 'settled');
  }

  register(submission: CanonicalChatSubmission, owner: MobileDeliveryOwner): MobileSubmissionRecord | undefined {
    if (!this.isCurrent()) return undefined;
    if (this.entries.has(submission.clientMsgId)) return undefined;
    const record: MobileSubmissionRecord = {
      clientMsgId: submission.clientMsgId, fence: this.options.fence, owner: { ...owner },
      canonical: copyCanonicalSubmission(submission), fact: { kind: 'unconfirmed' }, createdAt: Date.now(),
      attempt: { id: 0, controller: new AbortController(), phase: { kind: 'settled' } },
    };
    this.entries.set(record.clientMsgId, record);
    this.beginAttempt(record);
    this.trace('registered', record);
    return record;
  }

  beginAttempt(record: MobileSubmissionRecord): MobileDeliveryAttempt | undefined {
    if (!this.owns(record) || record.fact.kind !== 'unconfirmed' || !record.canonical) return undefined;
    this.clearAttempt(record);
    const attempt: MobileDeliveryAttempt = {
      id: ++this.serial, controller: new AbortController(),
      phase: { kind: 'connecting', deadlineAt: Date.now() + MOBILE_CONNECT_DEADLINE_MS },
    };
    record.attempt = attempt;
    this.arm(record, attempt);
    this.notify(record);
    return attempt;
  }

  rememberBubble(record: MobileSubmissionRecord, bubble: DeliveryBubble): void {
    if (!this.owns(record) || bubble.clientMsgId !== record.clientMsgId) return;
    record.bubble = { ...bubble };
    this.notify(record);
  }

  transportFinished(record: MobileSubmissionRecord, attempt: MobileDeliveryAttempt, written: boolean): void {
    if (!this.ownsAttempt(record, attempt) || record.fact.kind !== 'unconfirmed' || attempt.phase.kind !== 'connecting') return;
    if (!written) { void this.verify(record.clientMsgId, 'transport'); return; }
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.phase = { kind: 'awaiting_ack', deadlineAt: Date.now() + MOBILE_ACK_DEADLINE_MS };
    this.arm(record, attempt);
    this.trace('transport_written', record);
    this.notify(record);
  }

  accept(evidence: MobileAcceptanceEvidence): boolean {
    const record = this.entries.get(evidence.clientMsgId);
    if (!record || !this.owns(record) || evidence.status === 'cancel_pending') return false;
    if (record.owner.sessionId && evidence.sessionId && record.owner.sessionId !== evidence.sessionId) return false;
    const previous = record.fact.kind === 'accepted' ? record.fact : undefined;
    if (previous?.runId && evidence.runId && previous.runId !== evidence.runId) return false;
    const nextPresentation = deliveryPresentation(evidence.status);
    const presentation = previous?.presentation === 'progressed' ? 'progressed'
      : nextPresentation === 'receipt' && previous ? previous.presentation : nextPresentation;
    if (evidence.sessionId) record.owner.sessionId = evidence.sessionId;
    // Commit the fact BEFORE callbacks/cleanup. UI exceptions cannot lose acceptance or resurrect a retry.
    record.fact = {
      kind: 'accepted', sessionId: evidence.sessionId ?? previous?.sessionId ?? record.owner.sessionId,
      runId: evidence.runId ?? previous?.runId, presentation,
    };
    record.canonical = undefined;
    this.clearAttempt(record);
    record.attempt.phase = { kind: 'settled' };
    this.probes.cancel(record.clientMsgId);
    const changed = !previous || previous.presentation !== presentation
      || previous.sessionId !== record.fact.sessionId || previous.runId !== record.fact.runId;
    if (changed) {
      this.trace(`accepted_${evidence.source}`, record);
      try { this.options.onAccepted(record, evidence); } catch { /* facts survive presentation failures */ }
    }
    this.notify(record);
    return true;
  }

  reject(clientMsgId: string, code?: string): void {
    const record = this.entries.get(clientMsgId);
    if (!record || !this.owns(record) || record.fact.kind === 'accepted') return;
    if (code === 'duplicate_inflight') { void this.verify(clientMsgId, 'server'); return; }
    record.fact = { kind: 'rejected', code };
    this.clearAttempt(record);
    this.probes.cancel(clientMsgId);
    record.attempt.phase = { kind: 'settled' };
    this.trace('rejected', record);
    this.notify(record);
  }

  verify(clientMsgId: string, trigger: 'manual' | 'recover' | 'deadline' | 'server' | 'transport'): Promise<MobileVerifyResult> {
    const record = this.entries.get(clientMsgId);
    if (!record || !this.owns(record)) return Promise.resolve({ kind: 'unknown', reason: 'cancelled' });
    if (record.fact.kind === 'accepted') return Promise.resolve({ kind: 'already_accepted' });
    if (record.fact.kind === 'rejected') return Promise.resolve({ kind: 'rejected' });
    const current = this.verifications.get(clientMsgId);
    if (current) return current;
    if (!this.options.canRead()) {
      this.unknown(record);
      return Promise.resolve({ kind: 'unknown', reason: 'cancelled' });
    }
    if (trigger !== 'manual') record.lastAutoProbeAt = Date.now();
    this.clearAttempt(record);
    const verification = ++this.serial;
    record.attempt.phase = { kind: 'verifying', deadlineAt: Date.now() + MESSAGE_STATUS_BUDGET_MS, verification };
    this.trace('verifying', record);
    this.notify(record);
    const promise: Promise<MobileVerifyResult> = this.probes.probe(clientMsgId, record.owner.sessionId).then(result => {
      if (!this.owns(record)) return { kind: 'unknown', reason: 'cancelled' } as const;
      if (record.fact.kind === 'accepted') return { kind: 'already_accepted' } as const;
      const phase = record.attempt.phase;
      if (phase.kind !== 'verifying' || phase.verification !== verification) return { kind: 'unknown', reason: 'cancelled' } as const;
      if (result.kind === 'accepted') {
        const value = result.value;
        const fallback: MobileAcceptanceEvidence = {
          clientMsgId: value.clientMessageId, sessionId: value.sessionId, runId: value.runId, status: value.status, source: 'status',
        };
        let evidence = fallback;
        try { evidence = this.options.mergeStatus(value); } catch { /* retain validated durable fact */ }
        this.accept(evidence);
      } else this.unknown(record);
      return result;
    }).catch((): MobileVerifyResult => {
      if (this.owns(record) && record.fact.kind === 'unconfirmed') this.unknown(record);
      return { kind: 'unknown', reason: 'network' };
    }).finally(() => { if (this.verifications.get(clientMsgId) === promise) this.verifications.delete(clientMsgId); });
    this.verifications.set(clientMsgId, promise);
    return promise;
  }

  /** A lifecycle notification is read-only. Expired attempts keep their ORIGINAL deadlines. */
  recover(): void {
    if (!this.isCurrent()) return;
    for (const record of this.entries.values()) {
      if (record.fact.kind !== 'unconfirmed') continue;
      const phase = record.attempt.phase;
      if (phase.kind === 'verifying') {
        if (phase.deadlineAt <= Date.now()) { this.probes.cancel(record.clientMsgId); this.unknown(record); }
        continue;
      }
      if (phase.kind === 'connecting' && phase.deadlineAt > Date.now()) continue;
      const expired = phase.kind !== 'settled' && phase.deadlineAt <= Date.now();
      if (!expired && record.lastAutoProbeAt !== undefined && Date.now() - record.lastAutoProbeAt < MOBILE_ACK_DEADLINE_MS) continue;
      void this.verify(record.clientMsgId, expired ? 'deadline' : 'recover');
    }
  }

  hydrateBubble(bubble: DeliveryBubble, owner: MobileDeliveryOwner): MobileSubmissionRecord | undefined {
    if (!this.isCurrent() || !bubble.clientMsgId) return undefined;
    let record = this.entries.get(bubble.clientMsgId);
    if (record && record.owner.sessionId && owner.sessionId && record.owner.sessionId !== owner.sessionId) return undefined;
    if (!record) {
      if (bubble.status === 'sent' || bubble.status === 'queued' || bubble.deliveryIssue === 'rejected') return undefined;
      record = {
        clientMsgId: bubble.clientMsgId, owner: { ...owner }, fence: this.options.fence,
        fact: { kind: 'unconfirmed' }, bubble, createdAt: bubble.timestamp ?? Date.now(),
        attempt: { id: ++this.serial, controller: new AbortController(), phase: { kind: 'settled' } },
      };
      this.entries.set(record.clientMsgId, record);
    }
    if (!record.transcriptObserved) record.bubble = bubble;
    return record;
  }

  observeHistory(messages: MessageItem[], sessionId: string): void {
    for (const message of messages) {
      if ((message.type !== 'user' && message.type !== 'user-voice') || !message.clientMsgId) continue;
      const record = this.entries.get(message.clientMsgId);
      if (!record || !this.owns(record) || (record.owner.sessionId && record.owner.sessionId !== sessionId)) continue;
      this.accept({ clientMsgId: record.clientMsgId, sessionId, status: 'accepted', source: 'history' });
      record.transcriptObserved = true;
      record.bubble = undefined;
    }
  }

  project(messages: MessageItem[], view: MobileDeliveryView): MessageItem[] {
    if (!this.isCurrent()) return messages;
    const ids = new Set<string>();
    const projected = messages.map(message => {
      if (message.type !== 'user' && message.type !== 'user-voice') return message;
      if (!message.clientMsgId) {
        if (message.type === 'user' && message.status === 'pending') return {
          ...message, status: 'failed' as const, deliveryIssue: 'missing_payload' as const,
          deliveryPhase: undefined, failedReason: '缺少原消息标识，无法核验；请复制内容重新编辑。',
        };
        return message;
      }
      ids.add(message.clientMsgId);
      const record = this.hydrateBubble(message, { draftId: view.draftId, ...(view.sessionId ? { sessionId: view.sessionId } : {}) });
      return record && ownsDeliveryView(record, view) ? projectDeliveryBubble(message, record) : message;
    });
    for (const record of this.entries.values()) {
      if (!record.bubble || ids.has(record.clientMsgId) || !ownsDeliveryView(record, view)) continue;
      projected.push(projectDeliveryBubble(record.bubble, record));
    }
    return dedupeDeliveryBubbles(projected);
  }

  activate(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.probes = new MessageStatusProbePool(this.options.request);
  }
  suspend(): void {
    for (const record of this.entries.values()) if (record.fact.kind === 'unconfirmed') {
      this.probes.cancel(record.clientMsgId);
      this.unknown(record);
    }
  }
  restoreReference(reference: import('./mobileChatDeliveryJournal').MobileDeliveryReference): void {
    if (!this.isCurrent() || this.entries.has(reference.clientMsgId)) return;
    this.entries.set(reference.clientMsgId, {
      clientMsgId: reference.clientMsgId, owner: { ...reference.owner }, createdAt: reference.createdAt,
      fence: this.options.fence, fact: { kind: 'unconfirmed' },
      attempt: { id: ++this.serial, controller: new AbortController(), phase: { kind: 'settled' } },
    });
  }

  dispose(): void {
    this.disposed = true;
    this.probes.dispose();
    for (const record of this.entries.values()) { this.clearAttempt(record); record.canonical = undefined; record.bubble = undefined; }
    this.entries.clear();
  }

  private owns(record: MobileSubmissionRecord): boolean { return this.isCurrent() && this.entries.get(record.clientMsgId) === record; }
  private ownsAttempt(record: MobileSubmissionRecord, attempt: MobileDeliveryAttempt): boolean {
    return this.owns(record) && record.attempt === attempt && !attempt.controller.signal.aborted;
  }
  private clearAttempt(record: MobileSubmissionRecord): void {
    if (record.attempt.timer) clearTimeout(record.attempt.timer);
    record.attempt.timer = undefined;
    record.attempt.controller.abort();
  }
  private arm(record: MobileSubmissionRecord, attempt: MobileDeliveryAttempt): void {
    if (attempt.phase.kind === 'settled') return;
    attempt.timer = setTimeout(() => {
      if (!this.ownsAttempt(record, attempt) || record.fact.kind !== 'unconfirmed') return;
      void this.verify(record.clientMsgId, 'deadline');
    }, Math.max(0, attempt.phase.deadlineAt - Date.now()));
  }
  private unknown(record: MobileSubmissionRecord): void {
    if (!this.owns(record) || record.fact.kind !== 'unconfirmed') return;
    this.clearAttempt(record);
    record.attempt.phase = { kind: 'settled' };
    this.trace('unknown', record);
    this.notify(record);
  }
  private notify(record: MobileSubmissionRecord): void {
    try { this.options.onChange(record); } catch { /* re-project from retained facts on next event */ }
  }
  private trace(stage: string, record: MobileSubmissionRecord): void {
    try { this.options.trace?.(stage, record); } catch { /* observability is never a delivery dependency */ }
  }
}

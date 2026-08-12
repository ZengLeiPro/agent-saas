import { createHash, randomUUID } from 'node:crypto';

import type { ModelOutputTransactionMode } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type {
  ModelRequestDiagnostic,
  ModelResponseMode,
  ModelTerminalStatus,
  ModelWireMode,
  RunContext,
} from './types.js';

const logger = createLogger('ResponsesAdapter');
const MAX_DIAGNOSTIC_EVENT_TYPES = 64;
const MAX_UNKNOWN_EVENT_TYPES = 20;

type FinishedDiagnostic = Extract<ModelRequestDiagnostic, { type: 'finished' }>;
export type FinishedOutcome = FinishedDiagnostic['outcome'];
export type FinishedPatch = Partial<Omit<FinishedDiagnostic,
  'type' | 'modelRequestId' | 'attemptId' | 'attempt' | 'outcome' | 'durationMs'>>;

export class ResponsesAttemptDiagnostics {
  readonly attemptId = randomUUID();
  readonly clientRequestId = randomUUID();
  private readonly startedAt = Date.now();
  private finishedOnce = false;
  private readonly checkpointsWritten = new Set<'response_created' | 'terminal_received'>();
  private httpStatus: number | undefined;
  private contentType: string | undefined;
  private upstreamRequestId: string | undefined;
  private wireMode: ModelWireMode | undefined;
  private responseBytes = 0;
  private frameCount = 0;
  private readonly eventTypeCounts: Record<string, number> = {};
  private readonly unknownEventTypes = new Set<string>();
  private receivedDone = false;
  private lastSequenceNumber: number | undefined;
  private terminalEventType: string | undefined;
  private terminalStatus: ModelTerminalStatus | undefined;
  private responseIdHash: string | undefined;
  private incompleteReason: string | undefined;
  private tailBytes: number | undefined;
  private tailHash: string | undefined;

  constructor(
    private readonly context: RunContext,
    private readonly init: {
      modelRequestId: string;
      attempt: number;
      model: string;
      responseMode: ModelResponseMode;
      outputTransactionMode: ModelOutputTransactionMode;
      maxOutputTokens: number;
      requestBodyBytes: number;
      toolsCount: number;
      hasPreviousResponseId: boolean;
    },
  ) {}

  async started(): Promise<void> {
    await this.record({
      type: 'started',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      clientRequestId: this.clientRequestId,
      model: this.init.model,
      protocol: 'responses',
      responseMode: this.init.responseMode,
      outputTransactionMode: this.init.outputTransactionMode,
      maxOutputTokens: this.init.maxOutputTokens,
      requestBodyBytes: this.init.requestBodyBytes,
      toolsCount: this.init.toolsCount,
      hasPreviousResponseId: this.init.hasPreviousResponseId,
    });
  }

  observeHttpResponse(response: Response): void {
    this.httpStatus = response.status;
    this.contentType = compactHeader(response.headers.get('content-type'));
    this.upstreamRequestId = compactHeader(
      response.headers.get('x-request-id')
      ?? response.headers.get('request-id')
      ?? response.headers.get('openai-request-id'),
    );
  }

  observeWireMode(wireMode: ModelWireMode | undefined): void {
    this.wireMode = wireMode;
  }

  observeBytes(bytes: number): void {
    this.responseBytes += Math.max(0, bytes);
  }

  observeFrame(): void {
    this.frameCount += 1;
  }

  observeDone(): void {
    this.receivedDone = true;
  }

  observeEvent(eventType: string, sequenceNumber: unknown): void {
    const normalized = compactDiagnosticToken(eventType, 120) || '(missing)';
    const key = Object.hasOwn(this.eventTypeCounts, normalized)
      || Object.keys(this.eventTypeCounts).length < MAX_DIAGNOSTIC_EVENT_TYPES - 1
      ? normalized
      : '(other)';
    this.eventTypeCounts[key] = (this.eventTypeCounts[key] ?? 0) + 1;
    if (typeof sequenceNumber === 'number' && Number.isFinite(sequenceNumber)) {
      this.lastSequenceNumber = sequenceNumber;
    }
  }

  observeUnknownEvent(eventType: string): void {
    const normalized = compactDiagnosticToken(eventType, 120);
    if (normalized && this.unknownEventTypes.size < MAX_UNKNOWN_EVENT_TYPES) {
      this.unknownEventTypes.add(normalized);
    }
  }

  observeTerminal(
    eventType: string,
    status: ModelTerminalStatus,
    responseId?: string,
    incompleteReason?: string,
  ): void {
    this.terminalEventType = compactDiagnosticToken(eventType, 120);
    this.terminalStatus = status;
    this.responseIdHash = responseId ? hashOpaqueId(responseId) : undefined;
    this.incompleteReason = compactDiagnosticToken(incompleteReason, 200);
  }

  observeTail(tail: string): void {
    this.tailBytes = Buffer.byteLength(tail, 'utf8');
    this.tailHash = createHash('sha256').update(tail).digest('hex').slice(0, 32);
  }

  async checkpoint(
    stage: 'response_created' | 'terminal_received',
    patch: {
      responseId?: string;
      actualModel?: string;
      terminalEventType?: string;
      terminalStatus?: ModelTerminalStatus;
      incompleteReason?: string;
      errorCode?: string;
    } = {},
  ): Promise<void> {
    if (this.checkpointsWritten.has(stage)) return;
    const { responseId, actualModel, terminalEventType, terminalStatus, incompleteReason, errorCode } = patch;
    if (responseId) this.responseIdHash = hashOpaqueId(responseId);
    const recorded = await this.record({
      type: 'checkpoint',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      stage,
      elapsedMs: Date.now() - this.startedAt,
      ...(this.responseIdHash ? { responseIdHash: this.responseIdHash } : {}),
      ...(actualModel ? { actualModel: compactDiagnosticToken(actualModel, 200) } : {}),
      ...(terminalEventType ? { terminalEventType: compactDiagnosticToken(terminalEventType, 120) } : {}),
      ...(terminalStatus ? { terminalStatus } : {}),
      ...(incompleteReason ? { incompleteReason: compactDiagnosticToken(incompleteReason, 200) } : {}),
      ...(errorCode ? { errorCode: compactDiagnosticToken(errorCode, 200) } : {}),
    });
    if (recorded) this.checkpointsWritten.add(stage);
  }

  async finished(outcome: FinishedOutcome, patch: FinishedPatch = {}): Promise<void> {
    if (this.finishedOnce) return;
    const recorded = await this.record({
      type: 'finished',
      modelRequestId: this.init.modelRequestId,
      attemptId: this.attemptId,
      attempt: this.init.attempt,
      outcome,
      durationMs: Date.now() - this.startedAt,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.contentType ? { contentType: this.contentType } : {}),
      ...(this.upstreamRequestId ? { upstreamRequestId: this.upstreamRequestId } : {}),
      outputTransactionMode: this.init.outputTransactionMode,
      ...(this.wireMode ? { wireMode: this.wireMode } : {}),
      ...(this.responseIdHash ? { responseIdHash: this.responseIdHash } : {}),
      ...(this.responseBytes > 0 ? { responseBytes: this.responseBytes } : {}),
      ...(this.frameCount > 0 ? { frameCount: this.frameCount } : {}),
      ...(Object.keys(this.eventTypeCounts).length > 0 ? { eventTypeCounts: { ...this.eventTypeCounts } } : {}),
      ...(this.unknownEventTypes.size > 0 ? { unknownEventTypes: [...this.unknownEventTypes] } : {}),
      ...(this.receivedDone ? { receivedDone: true } : {}),
      ...(this.lastSequenceNumber !== undefined ? { lastSequenceNumber: this.lastSequenceNumber } : {}),
      ...(this.terminalEventType ? { terminalEventType: this.terminalEventType } : {}),
      ...(this.terminalStatus ? { terminalStatus: this.terminalStatus } : {}),
      ...(this.incompleteReason ? { incompleteReason: this.incompleteReason } : {}),
      ...(this.tailBytes !== undefined ? { tailBytes: this.tailBytes } : {}),
      ...(this.tailHash ? { tailHash: this.tailHash } : {}),
      ...sanitizeFinishedPatch(patch),
    });
    if (recorded) {
      this.finishedOnce = true;
    } else if (patch.usage) {
      throw new Error('MODEL_USAGE_DIAGNOSTIC_PERSIST_FAILED: failed attempt usage was not persisted');
    }
  }

  isFinished(): boolean {
    return this.finishedOnce;
  }

  private async record(event: ModelRequestDiagnostic): Promise<boolean> {
    if (!this.context.recordModelRequestDiagnostic) return true;
    try {
      return await this.context.recordModelRequestDiagnostic(event) !== false;
    } catch (err) {
      logger.warn(`model request diagnostic recorder failed: ${compactDiagnosticMessage(err)}`);
      return false;
    }
  }
}

export function compactDiagnosticMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  return raw
    .replace(/((?:"|')?(?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)(?:"|')?\s*:\s*)(?:"[^"]*"|'[^']*')/gi, '$1"[REDACTED]"')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)(?:[^@\s/]+@)?([^?\s#]+)\?[^\s#]*/gi, '$1$2?[REDACTED]')
    .replace(/\b(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function compactDiagnosticError(value: unknown): string {
  const message = compactDiagnosticMessage(value);
  if (!(value instanceof Error)) return message;
  const cause = (value as Error & { cause?: unknown }).cause;
  if (!cause || (typeof cause !== 'object' && typeof cause !== 'string')) return message;

  const causeRecord = typeof cause === 'object' ? cause as Record<string, unknown> : undefined;
  const causeCode = compactDiagnosticToken(causeRecord?.code, 100);
  const causeMessage = compactDiagnosticMessage(
    cause instanceof Error
      ? cause
      : typeof causeRecord?.message === 'string'
        ? causeRecord.message
        : typeof cause === 'string'
          ? cause
          : '',
  );
  const causeDetails = [causeCode, causeMessage].filter(Boolean).join(': ');
  return causeDetails ? compactDiagnosticMessage(`${message} (cause=${causeDetails})`) : message;
}

export function compactHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().slice(0, 200);
  return compact || undefined;
}

export function compactDiagnosticToken(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
  return compact || undefined;
}

export function compactDiagnosticCode(value: unknown): string | undefined {
  const candidate = compactDiagnosticToken(value, 120);
  return candidate && /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : undefined;
}

function sanitizeFinishedPatch(patch: FinishedPatch): FinishedPatch {
  return {
    ...patch,
    ...(patch.errorCode ? { errorCode: compactDiagnosticCode(patch.errorCode) ?? 'MODEL_PROVIDER_ERROR' } : {}),
    ...(patch.errorMessage ? { errorMessage: compactDiagnosticMessage(patch.errorMessage) } : {}),
  };
}

function hashOpaqueId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}


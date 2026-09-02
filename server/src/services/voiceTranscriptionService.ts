import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { SttConfig, SttResult } from '../integrations/stt/sttClient.js';
import { speechToText } from '../integrations/stt/sttClient.js';
import type { UploadManager } from '../uploads/manager.js';
import {
  VOICE_MAX_DURATION_MS,
  VOICE_MAX_FILE_BYTES,
  VOICE_MIME_TYPES,
  VOICE_MIN_DURATION_MS,
} from '../../../shared/src/lib/voiceRecording.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DURATION_TOLERANCE_MS = 750;

export type VoiceTranscriptionErrorCode =
  | 'VOICE_REQUEST_INVALID'
  | 'VOICE_ATTACHMENT_FORBIDDEN'
  | 'VOICE_MIME_INVALID'
  | 'VOICE_SIZE_INVALID'
  | 'VOICE_DURATION_INVALID'
  | 'STT_NOT_CONFIGURED'
  | 'STT_TIMEOUT'
  | 'STT_SILENCE'
  | 'STT_PROVIDER_ERROR';

export class VoiceTranscriptionError extends Error {
  constructor(readonly code: VoiceTranscriptionErrorCode, message: string, readonly statusCode: number) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

export interface VoiceTranscriptionResult {
  requestId: string;
  transcriptionId: string;
  attachmentId: string;
  status: 'ready';
  text: string;
  durationMs: number;
  source: 'server_stt';
  idempotentReplay?: boolean;
}

interface VoiceTranscriptionRequest {
  requestId: string;
  attachmentId: string;
  durationMs: number;
}

export interface VoiceTranscriptionServiceOptions {
  uploadManager: Pick<UploadManager, 'getAttachmentContent'>;
  sttConfig?: SttConfig;
  timeoutMs?: number;
  transcribe?: (path: string, config: SttConfig, signal: AbortSignal) => Promise<SttResult>;
  inspectDuration?: (path: string) => Promise<number>;
}

interface RequestEntry {
  request: VoiceTranscriptionRequest;
  promise: Promise<VoiceTranscriptionResult>;
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.toString('ascii', offset, offset + length);
}

/** Parse PCM WAV metadata without invoking ffprobe or trusting client duration. */
export async function inspectPcmWavDuration(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 44 || readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WAVE') {
      throw new VoiceTranscriptionError('VOICE_MIME_INVALID', '仅支持 PCM WAV 语音', 422);
    }
    let offset = 12;
    let byteRate = 0;
    let dataBytes = -1;
    while (offset + 8 <= bytesRead) {
      const id = readAscii(buffer, offset, 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && size >= 16 && offset + 24 <= bytesRead) {
        const format = buffer.readUInt16LE(offset + 8);
        const channels = buffer.readUInt16LE(offset + 10);
        const sampleRate = buffer.readUInt32LE(offset + 12);
        byteRate = buffer.readUInt32LE(offset + 16);
        if (format !== 1 || channels !== 1 || sampleRate !== 16_000 || byteRate !== 32_000) {
          throw new VoiceTranscriptionError('VOICE_MIME_INVALID', '语音必须为 16kHz mono 16-bit PCM WAV', 422);
        }
      } else if (id === 'data') {
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!byteRate || dataBytes < 0) throw new VoiceTranscriptionError('VOICE_MIME_INVALID', 'WAV 音频头无效', 422);
    return Math.round((dataBytes / byteRate) * 1000);
  } finally {
    await handle.close();
  }
}

function sameRequest(left: VoiceTranscriptionRequest, right: VoiceTranscriptionRequest): boolean {
  return left.requestId === right.requestId && left.attachmentId === right.attachmentId && left.durationMs === right.durationMs;
}

export class VoiceTranscriptionService {
  private readonly requests = new Map<string, RequestEntry>();
  private readonly resultsById = new Map<string, VoiceTranscriptionResult>();
  private readonly timeoutMs: number;
  private readonly transcribe: NonNullable<VoiceTranscriptionServiceOptions['transcribe']>;
  private readonly inspectDuration: NonNullable<VoiceTranscriptionServiceOptions['inspectDuration']>;

  constructor(private readonly options: VoiceTranscriptionServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.transcribe = options.transcribe ?? ((path, config, signal) => speechToText(path, config, { signal }));
    this.inspectDuration = options.inspectDuration ?? inspectPcmWavDuration;
  }

  async request(userCwd: string, input: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    if (!UUID_RE.test(input.requestId) || !UUID_RE.test(input.attachmentId)
      || !Number.isSafeInteger(input.durationMs)) {
      throw new VoiceTranscriptionError('VOICE_REQUEST_INVALID', '语音转写请求无效', 400);
    }
    const key = `${userCwd}\0${input.requestId}`;
    const existing = this.requests.get(key);
    if (existing) {
      if (!sameRequest(existing.request, input)) {
        throw new VoiceTranscriptionError('VOICE_REQUEST_INVALID', 'requestId 已绑定到其他语音', 409);
      }
      return { ...(await existing.promise), idempotentReplay: true };
    }
    const promise = this.execute(userCwd, input);
    this.requests.set(key, { request: { ...input }, promise });
    try {
      return await promise;
    } catch (error) {
      // Deterministic validation/not-configured results are idempotent. Provider/timeout may be retried with a new requestId.
      throw error;
    }
  }

  getAuthoritative(userCwd: string, transcriptionId: string): VoiceTranscriptionResult | undefined {
    const result = this.resultsById.get(`${userCwd}\0${transcriptionId}`);
    return result ? { ...result } : undefined;
  }

  private async execute(userCwd: string, input: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    let attachment;
    try {
      attachment = await this.options.uploadManager.getAttachmentContent(userCwd, input.attachmentId);
    } catch {
      throw new VoiceTranscriptionError('VOICE_ATTACHMENT_FORBIDDEN', '语音附件不存在或无权访问', 403);
    }
    if (!(VOICE_MIME_TYPES as readonly string[]).includes(attachment.mimeType.toLowerCase())) {
      throw new VoiceTranscriptionError('VOICE_MIME_INVALID', '语音附件 MIME 不受支持', 422);
    }
    if (attachment.size <= 44 || attachment.size > VOICE_MAX_FILE_BYTES) {
      throw new VoiceTranscriptionError('VOICE_SIZE_INVALID', '语音附件大小不合法', 422);
    }
    const actualDuration = await this.inspectDuration(attachment.absolutePath);
    if (actualDuration < VOICE_MIN_DURATION_MS || actualDuration > VOICE_MAX_DURATION_MS
      || Math.abs(actualDuration - input.durationMs) > DURATION_TOLERANCE_MS) {
      throw new VoiceTranscriptionError('VOICE_DURATION_INVALID', '语音时长与服务端检测结果不一致', 422);
    }
    if (!this.options.sttConfig?.apiKey) {
      throw new VoiceTranscriptionError('STT_NOT_CONFIGURED', '服务端未配置语音识别', 503);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let stt: SttResult;
    try {
      stt = await this.transcribe(attachment.absolutePath, this.options.sttConfig, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceTranscriptionError('STT_TIMEOUT', '语音识别超时', 504);
      throw new VoiceTranscriptionError('STT_PROVIDER_ERROR', '语音识别供应商调用失败', 502);
    } finally {
      clearTimeout(timer);
    }
    const text = stt.text.trim();
    if (!text) throw new VoiceTranscriptionError('STT_SILENCE', '未检测到可识别语音', 422);
    const result: VoiceTranscriptionResult = {
      requestId: input.requestId,
      transcriptionId: randomUUID(),
      attachmentId: input.attachmentId,
      status: 'ready',
      text,
      durationMs: actualDuration,
      source: 'server_stt',
    };
    this.resultsById.set(`${userCwd}\0${result.transcriptionId}`, result);
    return result;
  }
}

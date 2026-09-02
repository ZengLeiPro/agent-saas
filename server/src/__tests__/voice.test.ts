import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceTranscriptionError,
  VoiceTranscriptionService,
} from '../services/voiceTranscriptionService.js';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const cwd = '/workspace/users/tenant/alice';

function attachment(patch: Record<string, unknown> = {}) {
  return {
    attachmentId: ATTACHMENT,
    absolutePath: '/server/private/uploads/audio.wav',
    originalName: 'audio.wav',
    size: 48_044,
    mimeType: 'audio/wav',
    isImage: false,
    ...patch,
  };
}

function service(options: {
  content?: ReturnType<typeof attachment>;
  inspectDuration?: () => Promise<number>;
  transcribe?: (path: string, config: any, signal: AbortSignal) => Promise<{ text: string; duration: number }>;
  configured?: boolean;
  timeoutMs?: number;
} = {}) {
  const getAttachmentContent = vi.fn(async (_cwd: string, id: string) => {
    if (id !== ATTACHMENT) throw new Error('not found');
    return options.content ?? attachment();
  });
  const transcribe = vi.fn(options.transcribe ?? (async () => ({ text: '服务端权威转写', duration: 1_500 })));
  return {
    getAttachmentContent,
    transcribe,
    value: new VoiceTranscriptionService({
      uploadManager: { getAttachmentContent } as any,
      ...(options.configured === false ? {} : { sttConfig: { apiKey: 'secret', ossAccessKeyId: 'id', ossAccessKeySecret: 'secret' } }),
      timeoutMs: options.timeoutMs,
      inspectDuration: options.inspectDuration ?? (async () => 1_500),
      transcribe,
    }),
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('M50-04 authoritative STT service', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it('is idempotent by requestId and returns the same transcriptionId without a second provider dispatch', async () => {
    const rig = service();
    const first = await rig.value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 });
    const replay = await rig.value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 });
    expect(replay).toMatchObject({ transcriptionId: first.transcriptionId, idempotentReplay: true, source: 'server_stt' });
    expect(rig.transcribe).toHaveBeenCalledOnce();
    expect(rig.value.getAuthoritative(cwd, first.transcriptionId)).toMatchObject({ attachmentId: ATTACHMENT, text: '服务端权威转写' });
    expect(rig.value.getAuthoritative('/workspace/users/tenant/bob', first.transcriptionId)).toBeUndefined();
  });

  it('rejects a reused requestId bound to a forged attachment', async () => {
    const rig = service();
    await rig.value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 });
    await expectCode(rig.value.request(cwd, { requestId: REQUEST, attachmentId: OTHER, durationMs: 1_500 }), 'VOICE_REQUEST_INVALID');
  });

  it('rejects forged owner/id, MIME, size and client duration before STT', async () => {
    await expectCode(service().value.request(cwd, { requestId: REQUEST, attachmentId: OTHER, durationMs: 1_500 }), 'VOICE_ATTACHMENT_FORBIDDEN');
    await expectCode(service({ content: attachment({ mimeType: 'audio/mpeg' }) }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'VOICE_MIME_INVALID');
    await expectCode(service({ content: attachment({ size: 11 * 1024 * 1024 }) }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'VOICE_SIZE_INVALID');
    await expectCode(service({ inspectDuration: async () => 4_000 }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'VOICE_DURATION_INVALID');
  });

  it('returns structured silence, not-configured and provider errors', async () => {
    await expectCode(service({ transcribe: async () => ({ text: '  ', duration: 1_500 }) }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'STT_SILENCE');
    await expectCode(service({ configured: false }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'STT_NOT_CONFIGURED');
    await expectCode(service({ transcribe: async () => { throw new Error('provider token and transcript must not escape'); } }).value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 }), 'STT_PROVIDER_ERROR');
  });

  it('times out through AbortSignal under a fake clock (no real sleep)', async () => {
    vi.useFakeTimers();
    const rig = service({
      timeoutMs: 100,
      transcribe: (_path, _config, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const pending = rig.value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 });
    const asserted = expectCode(pending, 'STT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100);
    await asserted;
  });

  it('never exposes provider details, audio paths, tokens or transcript text in structured errors', async () => {
    const rig = service({ transcribe: async () => { throw new Error('token=secret /server/private/uploads/audio.wav 全文敏感转写'); } });
    try {
      await rig.value.request(cwd, { requestId: REQUEST, attachmentId: ATTACHMENT, durationMs: 1_500 });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceTranscriptionError);
      expect(JSON.stringify(error)).not.toMatch(/secret|private|全文敏感/);
    }
  });
});

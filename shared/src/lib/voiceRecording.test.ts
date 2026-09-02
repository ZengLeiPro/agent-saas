import { describe, expect, it } from 'vitest';
import {
  assertNoLocalVoiceReference,
  createVoiceIntent,
  reduceVoiceIntent,
  selectVoiceRenderCard,
  VOICE_MAX_DURATION_MS,
} from './voiceRecording';

const VOICE = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT = '33333333-3333-4333-8333-333333333333';
const TRANSCRIPTION = '44444444-4444-4444-8444-444444444444';
const fresh = () => createVoiceIntent({ voiceIntentId: VOICE, uploadRequestId: UPLOAD });
const recording = () => reduceVoiceIntent(reduceVoiceIntent(fresh(), { type: 'press_record' }), { type: 'permission_granted' });
const uploaded = () => reduceVoiceIntent(
  reduceVoiceIntent(reduceVoiceIntent(recording(), { type: 'stop' }), { type: 'recorded', durationMs: 1_500, size: 48_000, mimeType: 'audio/wav' }),
  { type: 'upload_succeeded', attachmentId: ATTACHMENT },
);

describe('M50-04 voice state machine', () => {
  it.each([[false, 'permission_denied', false], [true, 'permission_permanently_denied', true]] as const)(
    'models permission denial permanent=%s and settings fallback',
    (permanent, code, canOpenSettings) => {
      const state = reduceVoiceIntent(reduceVoiceIntent(fresh(), { type: 'press_record' }), { type: 'permission_denied', permanent });
      expect(state).toMatchObject({ status: 'failed', errorCode: code, canOpenSettings });
    },
  );

  it('enforces minimum, maximum, size and format at the stopping boundary', () => {
    const stop = reduceVoiceIntent(recording(), { type: 'stop' });
    expect(reduceVoiceIntent(stop, { type: 'recorded', durationMs: 999, size: 10, mimeType: 'audio/wav' }).errorCode).toBe('too_short');
    expect(reduceVoiceIntent(stop, { type: 'recorded', durationMs: VOICE_MAX_DURATION_MS + 1, size: 10, mimeType: 'audio/wav' }).errorCode).toBe('too_long');
    expect(reduceVoiceIntent(stop, { type: 'recorded', durationMs: 1_500, size: 10 * 1024 * 1024 + 1, mimeType: 'audio/wav' }).errorCode).toBe('file_too_large');
    expect(reduceVoiceIntent(stop, { type: 'recorded', durationMs: 1_500, size: 10, mimeType: 'audio/mpeg' }).errorCode).toBe('unsupported_format');
  });

  it('is single-flight under double tap and ignores late callbacks after cancel race', () => {
    const requested = reduceVoiceIntent(fresh(), { type: 'press_record' });
    expect(reduceVoiceIntent(requested, { type: 'press_record' })).toBe(requested);
    const cancelled = reduceVoiceIntent(uploaded(), { type: 'cancel', reason: 'backgrounded' });
    expect(reduceVoiceIntent(cancelled, { type: 'transcription_succeeded', transcriptionId: TRANSCRIPTION, text: 'forged late success' })).toBe(cancelled);
  });

  it.each(['interrupted', 'backgrounded', 'identity_boundary'] as const)('safely cancels an unconfirmed intent on %s', (reason) => {
    expect(reduceVoiceIntent(recording(), { type: 'cancel', reason })).toMatchObject({ status: 'cancelled', errorCode: reason });
  });

  it('retries upload/STT with stable IDs and never manufactures local success', () => {
    const uploading = reduceVoiceIntent(reduceVoiceIntent(recording(), { type: 'stop' }), { type: 'recorded', durationMs: 1_500, size: 48_000, mimeType: 'audio/wav' });
    const retriedUpload = reduceVoiceIntent(reduceVoiceIntent(uploading, { type: 'upload_failed' }), { type: 'retry_upload' });
    expect(retriedUpload).toMatchObject({ status: 'uploading', voiceIntentId: VOICE, uploadRequestId: UPLOAD, attempt: 2 });
    const retriedStt = reduceVoiceIntent(reduceVoiceIntent(uploaded(), { type: 'transcription_failed', code: 'stt_timeout' }), { type: 'retry_transcription' });
    expect(retriedStt).toMatchObject({ status: 'transcribing', attachmentId: ATTACHMENT, transcriptionId: undefined });
  });

  it('allows editing a server transcript and dispatches explicitly exactly once', () => {
    let state = reduceVoiceIntent(uploaded(), { type: 'transcription_succeeded', transcriptionId: TRANSCRIPTION, text: '服务端文本' });
    state = reduceVoiceIntent(state, { type: 'edit_transcript', text: '用户编辑文本' });
    expect(selectVoiceRenderCard(state)).toMatchObject({ status: 'ready', transcript: '用户编辑文本', canSend: true, canPlay: true });
    state = reduceVoiceIntent(state, { type: 'dispatch' });
    expect(state.dispatchCount).toBe(1);
    expect(reduceVoiceIntent(state, { type: 'dispatch' })).toBe(state);
  });

  it('rejects local paths from durable/queue/replay metadata', () => {
    expect(() => assertNoLocalVoiceReference({ attachmentId: ATTACHMENT, transcriptionId: TRANSCRIPTION })).not.toThrow();
    expect(() => assertNoLocalVoiceReference({ voiceFile: { savedPath: '/tmp/voice.wav' } })).toThrow(/forbidden/);
    expect(() => assertNoLocalVoiceReference({ nested: 'file:///private/voice.wav' })).toThrow(/forbidden/);
  });
});

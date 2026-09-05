import { useCallback, useEffect, useRef } from 'react';
import { File } from 'expo-file-system';
import type { CanonicalVoiceSubmission } from '@agent/shared';
import { authFetch } from '@agent/shared';
import { telemetryClient } from '../telemetry/runtime';
import type { MessagesState } from './useMessages';
import type { useFileUpload } from './useFileUpload';

function voiceFailureAction(code: string): string {
  switch (code.toLowerCase()) {
    case 'upload_failed':
      return '语音上传失败，请重录；也可改用文字发送。';
    case 'stt_silence':
      return '未识别到有效语音，请重录或改用文字发送。';
    case 'stt_timeout':
      return '语音识别超时，请重试录音或改用文字发送。';
    case 'stt_not_configured':
      return '语音识别暂不可用，请改用文字发送。';
    default:
      return '语音处理失败，请重录；仍失败时可改用文字发送。';
  }
}

function createVoiceId(): string {
  const id = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (!id) throw new Error('设备安全随机数能力不可用');
  return id;
}

export interface VoiceCaptureDeps {
  msg: MessagesState;
  fileUpload: ReturnType<typeof useFileUpload>;
  setInput: (value: string) => void;
  /** `租户:用户:代`；变化即作废待发送的语音草稿。 */
  identityKey: string;
}

/**
 * 录音 → 受控上传（M50-03）→ 服务端权威转写 → 可编辑草稿；不自动派发
 * （从 useChatAppStateCore 按域拆出，逻辑原样）。
 */
export function useVoiceCapture({ msg, fileUpload, setInput, identityKey }: VoiceCaptureDeps) {
  const pendingVoiceRef = useRef<{ base: CanonicalVoiceSubmission; serverText: string } | null>(
    null,
  );
  const voiceIdentityRef = useRef(identityKey);
  useEffect(() => {
    if (voiceIdentityRef.current !== identityKey) {
      pendingVoiceRef.current = null;
      voiceIdentityRef.current = identityKey;
    }
  }, [identityKey]);

  // Record -> controlled M50-03 upload -> authoritative STT -> editable draft. No automatic dispatch.
  const sendVoiceMessage = useCallback(
    async (fileUri: string, durationMs: number) => {
      const voiceIntentId = createVoiceId();
      const uploadRequestId = createVoiceId();
      const transcriptionRequestId = createVoiceId();
      const durationSec = Math.round(durationMs / 1000);
      const voiceMsgIndex = msg.addMessage({
        type: 'user-voice',
        audioUrl: '',
        duration: durationSec,
        status: 'uploading',
        timestamp: Date.now(),
      });
      msg.triggerScroll();
      try {
        const formData = new FormData();
        formData.append('files', {
          uri: fileUri,
          name: `voice_${voiceIntentId}.wav`,
          type: 'audio/wav',
        } as unknown as Blob);
        const uploadRes = await authFetch('/api/upload', {
          method: 'POST',
          body: formData,
          headers: { 'X-Upload-Request-Id': uploadRequestId },
        });
        const uploadData = (await uploadRes.json()) as {
          success?: boolean;
          files?: Array<{
            attachmentId?: string;
            originalName?: string;
            size?: number;
            mimeType?: string;
            isImage?: boolean;
          }>;
        };
        const uploaded = uploadData.files?.[0];
        if (!uploadRes.ok || !uploadData.success || !uploaded?.attachmentId)
          throw new Error('upload_failed');
        const audioUrl = `/api/attachments/${encodeURIComponent(uploaded.attachmentId)}/content`;
        msg.updateMessageAt(voiceMsgIndex, (m) =>
          m.type === 'user-voice'
            ? {
                ...m,
                audioUrl,
                attachmentId: uploaded.attachmentId,
                voiceIntentId,
                uploadRequestId,
                status: 'transcribing' as const,
              }
            : m,
        );
        const sttRes = await authFetch('/api/voice/transcriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: transcriptionRequestId,
            attachmentId: uploaded.attachmentId,
            durationMs,
          }),
        });
        const sttData = (await sttRes.json()) as {
          success?: boolean;
          result?: { transcriptionId: string; text: string; durationMs: number };
          error?: { code?: string; message?: string };
        };
        if (!sttRes.ok || !sttData.success || !sttData.result)
          throw new Error(sttData.error?.code || 'stt_provider_error');
        const base: CanonicalVoiceSubmission = {
          voiceIntentId,
          uploadRequestId,
          attachmentId: uploaded.attachmentId,
          transcriptionId: sttData.result.transcriptionId,
          durationMs: sttData.result.durationMs,
          transcript: {
            status: 'ready',
            text: sttData.result.text,
            edited: false,
            source: 'server_stt',
          },
        };
        pendingVoiceRef.current = { base, serverText: sttData.result.text };
        fileUpload.addUploadedFiles([
          {
            attachmentId: uploaded.attachmentId,
            originalName: uploaded.originalName || '语音.wav',
            relativePath: '',
            size: uploaded.size ?? 0,
            mimeType: uploaded.mimeType || 'audio/wav',
            isImage: false,
          },
        ]);
        setInput(sttData.result.text);
        msg.updateMessageAt(voiceMsgIndex, (m) =>
          m.type === 'user-voice'
            ? {
                ...m,
                transcribedText: sttData.result!.text,
                transcriptionId: sttData.result!.transcriptionId,
                status: 'ready' as const,
              }
            : m,
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : 'stt_provider_error';
        const reasonCode = ['upload_failed', 'stt_provider_error', 'transcription_failed'].includes(
          code.toLowerCase(),
        )
          ? code.toLowerCase()
          : 'voice_failed';
        telemetryClient()?.capture('voice_error', {
          correlationId: voiceIntentId,
          measurements: { reasonCode },
        });
        msg.updateMessageAt(voiceMsgIndex, (m) =>
          m.type === 'user-voice'
            ? { ...m, status: 'failed' as const, failedReason: voiceFailureAction(code) }
            : m,
        );
      } finally {
        try {
          new File(fileUri).delete();
        } catch {}
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileUpload, msg],
  );

  return { pendingVoiceRef, sendVoiceMessage };
}

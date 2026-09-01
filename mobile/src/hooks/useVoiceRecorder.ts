import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState, Alert } from 'react-native';
import { useAudioRecorder, setAudioModeAsync, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import {
  VOICE_MAX_DURATION_MS,
  VOICE_MAX_FILE_BYTES,
  VOICE_MIN_DURATION_MS,
  type VoiceStatus,
} from '@agent/shared';
import {
  openAppSettingsForPermissionFallback,
  requestMicrophoneForUserAction,
} from '../platform/jitMediaPermissions';

/** Explicit mobile recording contract: 16kHz mono 16-bit PCM WAV, 1s..180s, <=10MiB. */
const WAV_PCM_PRESET: RecordingOptions = {
  extension: '.wav', sampleRate: 16000, numberOfChannels: 1, bitRate: 256000,
  android: { outputFormat: 'default', audioEncoder: 'default' },
  ios: {
    outputFormat: 'lpcm', audioQuality: 127, linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false, linearPCMIsFloat: false,
  },
  web: {},
};

export interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isCancelled: boolean;
  status: VoiceStatus;
  duration: number;
  startRecording: () => Promise<void>;
  stopAndSend: () => Promise<void>;
  cancelRecording: () => void;
}

interface UseVoiceRecorderOptions {
  onVoiceSend: (fileUri: string, durationMs: number) => Promise<void>;
  onTooShort?: () => void;
  /** Recording is fenced whenever the authenticated identity changes. */
  identityKey?: string;
}

export function useVoiceRecorder({ onVoiceSend, onTooShort, identityKey }: UseVoiceRecorderOptions): UseVoiceRecorderReturn {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [duration, setDuration] = useState(0);
  const recorder = useAudioRecorder(WAV_PCM_PRESET);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);
  const cancelledRef = useRef(false);
  const singleFlightRef = useRef(false);
  const permissionPendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const identityRef = useRef(identityKey);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const reset = useCallback((terminal: VoiceStatus = 'idle') => {
    clearTimer();
    activeRef.current = false;
    singleFlightRef.current = false;
    permissionPendingRef.current = false;
    stoppingRef.current = false;
    setDuration(0);
    setStatus(terminal);
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
  }, [clearTimer]);

  const stopInternal = useCallback(async (send: boolean, terminalReason: VoiceStatus = 'cancelled') => {
    if (!activeRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    activeRef.current = false;
    clearTimer();
    setStatus('stopping');
    const elapsed = Math.min(VOICE_MAX_DURATION_MS, Date.now() - startTimeRef.current);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) { Alert.alert('录音失败', '未生成录音文件，请重录或改用文字发送。'); reset('failed'); return; }
      const file = new File(uri);
      const shouldSend = send && !cancelledRef.current;
      if (!shouldSend) {
        try { file.delete(); } catch {}
        reset(terminalReason);
        return;
      }
      if (elapsed < VOICE_MIN_DURATION_MS) {
        onTooShort?.();
        try { file.delete(); } catch {}
        reset('failed');
        return;
      }
      if (elapsed > VOICE_MAX_DURATION_MS || (file.size ?? 0) > VOICE_MAX_FILE_BYTES) {
        try { file.delete(); } catch {}
        Alert.alert('录音无法发送', elapsed > VOICE_MAX_DURATION_MS ? '录音超过 3 分钟上限' : '录音超过 10 MiB 上限');
        reset('failed');
        return;
      }
      setStatus('uploading');
      await onVoiceSend(uri, elapsed);
      reset('idle');
    } catch {
      Alert.alert('语音处理失败', '请重录；仍失败时可改用文字发送。');
      reset('failed');
    }
  }, [clearTimer, onTooShort, onVoiceSend, recorder, reset]);

  const startRecording = useCallback(async () => {
    // This is called only by the microphone press. The fence is set before awaiting permission.
    if (singleFlightRef.current || activeRef.current) return;
    singleFlightRef.current = true;
    permissionPendingRef.current = true;
    cancelledRef.current = false;
    setStatus('requesting_permission');
    try {
      const permission = await requestMicrophoneForUserAction();
      permissionPendingRef.current = false;
      if (cancelledRef.current || AppState.currentState !== 'active') {
        reset('cancelled');
        return;
      }
      if (!permission.granted) {
        singleFlightRef.current = false;
        setStatus('failed');
        if (permission.permanentlyDenied) {
          Alert.alert('需要麦克风权限', '请在系统设置中允许麦克风权限。', [
            { text: '取消', style: 'cancel' },
            { text: '打开设置', onPress: () => { void openAppSettingsForPermissionFallback(); } },
          ]);
        } else {
          Alert.alert('未获得麦克风权限', '你仍可直接输入文字发送；再次录音时会重新请求权限。');
        }
        return;
      }
      // No background mode is enabled; this mode is reset immediately on every stop/fence.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startTimeRef.current = Date.now();
      activeRef.current = true;
      setDuration(0);
      setStatus('recording');
      timerRef.current = setInterval(() => {
        const elapsed = Math.min(VOICE_MAX_DURATION_MS, Date.now() - startTimeRef.current);
        setDuration(Math.floor(elapsed / 1000));
        if (elapsed >= VOICE_MAX_DURATION_MS) void stopInternal(true);
      }, 200);
    } catch {
      Alert.alert('无法开始录音', '请重试；仍失败时可改用文字发送。');
      reset('failed');
    }
  }, [recorder, reset, stopInternal]);

  const stopAndSend = useCallback(() => stopInternal(true), [stopInternal]);
  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (!activeRef.current && singleFlightRef.current) {
      reset('cancelled');
      return;
    }
    void stopInternal(false, 'cancelled');
  }, [reset, stopInternal]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && (activeRef.current || permissionPendingRef.current)) {
        cancelledRef.current = true;
        if (!activeRef.current) reset('cancelled');
        else void stopInternal(false, 'cancelled');
      }
    });
    return () => subscription.remove();
  }, [reset, stopInternal]);

  useEffect(() => {
    if (identityRef.current !== identityKey) {
      identityRef.current = identityKey;
      cancelledRef.current = true;
      if (!activeRef.current && singleFlightRef.current) reset('cancelled');
      else void stopInternal(false, 'cancelled');
    }
  }, [identityKey, reset, stopInternal]);

  useEffect(() => () => {
    cancelledRef.current = true; // offscreen/unmount fence
    clearTimer();
    if (activeRef.current) {
      activeRef.current = false;
      void recorder.stop().then(() => {
        const uri = recorder.uri;
        if (uri) { try { new File(uri).delete(); } catch {} }
      }).catch(() => undefined);
    }
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
  }, [clearTimer, recorder]);

  return { isRecording: status === 'recording', isCancelled: status === 'cancelled', status, duration, startRecording, stopAndSend, cancelRecording };
}

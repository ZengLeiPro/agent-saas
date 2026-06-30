import { useState, useRef, useCallback, useEffect } from 'react';
import { useAudioRecorder, AudioModule, setAudioModeAsync, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';

const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 1800000;

/** 16kHz mono WAV — 与服务端 ASR 格式一致 */
const WAV_PCM_PRESET: RecordingOptions = {
  extension: '.wav',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 256000,
  android: {
    outputFormat: 'default',
    audioEncoder: 'default',
  },
  ios: {
    outputFormat: 'lpcm',
    audioQuality: 127,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

export interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isCancelled: boolean;
  duration: number; // seconds
  startRecording: () => Promise<void>;
  stopAndSend: () => Promise<void>;
  cancelRecording: () => void;
}

interface UseVoiceRecorderOptions {
  onVoiceSend: (fileUri: string, durationMs: number) => Promise<void>;
  onTooShort?: () => void;
}

export function useVoiceRecorder({ onVoiceSend, onTooShort }: UseVoiceRecorderOptions): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [duration, setDuration] = useState(0);

  const recorder = useAudioRecorder(WAV_PCM_PRESET);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const recordingActiveRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setIsCancelled(false);
    setDuration(0);
    cancelledRef.current = false;
    recordingActiveRef.current = false;
  }, []);

  // Auto-stop at max duration
  useEffect(() => {
    if (isRecording && duration >= MAX_DURATION_MS / 1000) {
      void stopAndSend();
    }
  }, [isRecording, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = useCallback(async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) return;

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();

      startTimeRef.current = Date.now();
      cancelledRef.current = false;
      recordingActiveRef.current = true;
      setIsRecording(true);
      setIsCancelled(false);
      setDuration(0);

      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);
      }, 200);
    } catch (error) {
      console.error('Failed to start recording:', error);
      cleanup();
    }
  }, [recorder, cleanup]);

  const stopAndSend = useCallback(async () => {
    if (!recordingActiveRef.current) return;

    const elapsed = Date.now() - startTimeRef.current;
    const wasCancelled = cancelledRef.current;
    cleanup();

    try {
      await recorder.stop();
      const uri = recorder.uri;

      if (wasCancelled) {
        if (uri) try { new File(uri).delete(); } catch {};
        return;
      }

      if (elapsed < MIN_DURATION_MS) {
        onTooShort?.();
        if (uri) try { new File(uri).delete(); } catch {};
        return;
      }

      if (!uri) return;
      await onVoiceSend(uri, elapsed);
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
  }, [recorder, cleanup, onVoiceSend, onTooShort]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    setIsCancelled(true);
    if (recordingActiveRef.current) {
      void stopAndSend();
    }
  }, [stopAndSend]);

  return { isRecording, isCancelled, duration, startRecording, stopAndSend, cancelRecording };
}

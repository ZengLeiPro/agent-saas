/**
 * 语音录制 Hook（点击式交互）
 *
 * 点击开始录音，点击停止发送。与 mobile 端行为一致。
 * 使用 AudioContext + ScriptProcessorNode 录制 16kHz 16bit mono PCM，
 * 录制完成后编码为 WAV Blob。
 */

import { useCallback, useRef, useState } from 'react';

/** 最短录音时长（秒） */
const MIN_DURATION = 1;
/** 最长录音时长（秒） */
const MAX_DURATION = 1800;
/** 目标采样率 */
const TARGET_SAMPLE_RATE = 16000;

export interface UseVoiceRecorderReturn {
  isRecording: boolean;
  duration: number;
  isSupported: boolean;
  ensurePermission: () => Promise<boolean>;
  startRecording: () => Promise<void>;
  stopAndSend: () => void;
  cancelRecording: () => void;
}

/** 将 Float32Array PCM 降采样到目标采样率并转为 Int16 */
function downsampleToInt16(input: Float32Array, inputSampleRate: number, outputSampleRate: number): Int16Array {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.round(i * ratio);
    const sample = Math.max(-1, Math.min(1, input[srcIndex] || 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

/** 将 Int16 PCM 编码为 WAV Blob */
function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  const pcmView = new Int16Array(buffer, 44);
  pcmView.set(samples);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function useVoiceRecorder(options: {
  onVoiceSend: (wavBlob: Blob, duration: number) => Promise<void>;
  onTooShort?: () => void;
}): UseVoiceRecorderReturn {
  const { onVoiceSend, onTooShort } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  const recordingRef = useRef(false);

  const isSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const permissionGrantedRef = useRef(false);

  const ensurePermission = useCallback(async (): Promise<boolean> => {
    if (permissionGrantedRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      permissionGrantedRef.current = true;
      return true;
    } catch {
      return false;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    recordingRef.current = false;
    setIsRecording(false);
    setDuration(0);
  }, []);

  const finishRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;

    const elapsedSec = (Date.now() - startTimeRef.current) / 1000;
    const inputSampleRate = audioContextRef.current?.sampleRate || 44100;

    const allChunks = chunksRef.current;
    cleanup();

    if (cancelledRef.current) return;

    if (elapsedSec < MIN_DURATION) {
      onTooShort?.();
      return;
    }

    const totalLength = allChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of allChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const int16 = downsampleToInt16(merged, inputSampleRate, TARGET_SAMPLE_RATE);
    const wavBlob = encodeWav(int16, TARGET_SAMPLE_RATE);
    const durationMs = Math.round(elapsedSec * 1000);

    await onVoiceSend(wavBlob, durationMs);
  }, [cleanup, onVoiceSend, onTooShort]);

  const startRecording = useCallback(async () => {
    if (recordingRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: { ideal: TARGET_SAMPLE_RATE } },
      });

      streamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioContextRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      chunksRef.current = [];
      cancelledRef.current = false;

      processor.onaudioprocess = (e) => {
        if (!recordingRef.current) return;
        const data = e.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(data));
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      recordingRef.current = true;
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setDuration(0);

      timerRef.current = setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setDuration(elapsed);

        if (elapsed >= MAX_DURATION) {
          finishRecording();
        }
      }, 100);
    } catch (err) {
      cleanup();
      throw err;
    }
  }, [cleanup, finishRecording]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    cleanup();
  }, [cleanup]);

  const stopAndSend = useCallback(() => {
    if (cancelledRef.current) {
      cleanup();
      return;
    }
    finishRecording();
  }, [finishRecording, cleanup]);

  return {
    isRecording,
    duration,
    isSupported,
    ensurePermission,
    startRecording,
    stopAndSend,
    cancelRecording,
  };
}

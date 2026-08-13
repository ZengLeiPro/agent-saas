/**
 * STT (Speech-to-Text) 核心模块
 * 使用阿里云百炼 DashScope 录音文件识别 API（fun-asr / paraformer-v2）。
 *
 * 本地文件会临时上传 OSS；http/https 直链会直接提交给 DashScope。
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import OSS from 'ali-oss';

/** STT 配置。OSS 凭证仅在转写本地文件时必需。 */
export interface SttConfig {
  /** DashScope API Key */
  apiKey: string;
  /** 识别模型，默认 fun-asr */
  model?: string;
  /** 阿里云 OSS Access Key ID */
  ossAccessKeyId: string;
  /** 阿里云 OSS Access Key Secret */
  ossAccessKeySecret: string;
  /** OSS Bucket 名称 */
  ossBucket?: string;
  /** OSS Endpoint（支持标准地域 endpoint 或 custom endpoint） */
  ossEndpoint?: string;
}

export interface SttOptions {
  /** 输出说话人标签；传数字时同时作为预期说话人数提交给 DashScope。 */
  speaker?: boolean | number;
  /** 每句前输出 [HH:MM:SS] 时间戳。 */
  timestamps?: boolean;
  /** 取消提交、轮询和结果下载。 */
  signal?: AbortSignal;
  /** 测试或运行时注入 fetch。 */
  fetchImpl?: typeof fetch;
  /** OSS 临时对象清理失败时的告警回调。 */
  onCleanupError?: (error: unknown) => void;
}

/** STT 识别结果 */
export interface SttResult {
  /** 识别出的文本（每句一行） */
  text: string;
  /** 音频时长（毫秒） */
  duration: number;
}

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
export const DEFAULT_STT_MODEL = 'fun-asr';
const DEFAULT_BUCKET = 'ky-azeroth-upload';
const DEFAULT_ENDPOINT = 'https://oss-cn-shenzhen.aliyuncs.com';
const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 600_000;

function endpointRegion(endpoint: string): string {
  try {
    const match = new URL(endpoint).hostname.match(/^(oss-[^.]+)\.aliyuncs\.com$/i);
    return match?.[1] ?? 'oss-cn-shenzhen';
  } catch {
    return 'oss-cn-shenzhen';
  }
}

function createOssClient(config: SttConfig): OSS {
  const endpoint = config.ossEndpoint || DEFAULT_ENDPOINT;
  return new OSS({
    region: endpointRegion(endpoint),
    endpoint,
    accessKeyId: config.ossAccessKeyId!,
    accessKeySecret: config.ossAccessKeySecret!,
    bucket: config.ossBucket || DEFAULT_BUCKET,
  });
}

async function uploadToOss(client: OSS, filePath: string): Promise<string> {
  const filename = basename(filePath);
  const ossKey = `tmp/stt/${Date.now()}_${randomUUID().slice(0, 8)}_${filename}`;
  await client.put(ossKey, filePath);
  return ossKey;
}

async function deleteFromOss(
  client: OSS,
  ossKey: string,
  onCleanupError?: (error: unknown) => void,
): Promise<void> {
  try {
    await client.delete(ossKey);
  } catch (error) {
    // 临时对象清理失败不能遮蔽转写主结果或主错误，但必须留下可观测告警。
    onCleanupError?.(error);
  }
}

interface TranscriptionTaskResponse {
  request_id?: string;
  output?: {
    task_id?: string;
    task_status?: string;
    code?: string;
    message?: string;
    results?: Array<{
      file_url?: string;
      transcription_url?: string;
    }>;
  };
}

interface TranscriptionSentence {
  text?: string;
  begin_time?: number;
  end_time?: number;
  speaker_id?: string | number;
  speaker?: string | number;
  spk_id?: string | number;
}

interface TranscriptionDetail {
  transcripts?: Array<{
    sentences?: TranscriptionSentence[];
  }>;
}

function isHttpUrl(input: string): boolean {
  try {
    const protocol = new URL(input).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function safeUpstreamError(text: string): string {
  let summary = '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    summary = [parsed.code, parsed.message]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(': ');
  } catch {
    summary = text;
  }
  return summary
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300) || '上游未返回可读错误';
}

function trustedResultUrl(raw: string, base?: string): URL {
  const url = new URL(raw, base);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !hostname.endsWith('.aliyuncs.com')) {
    throw new Error('DashScope 返回了不受信任的转写结果地址');
  }
  return url;
}

async function fetchTrustedResult(rawUrl: string, options: SttOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = trustedResultUrl(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(current, { signal: options.signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('DashScope 转写结果重定向异常');
    current = trustedResultUrl(location, current.toString());
  }
  throw new Error('DashScope 转写结果重定向过多');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function submitTranscription(
  fileUrl: string,
  config: SttConfig,
  options: SttOptions,
): Promise<string> {
  const parameters: Record<string, unknown> = { language_hints: ['zh', 'en'] };
  if (options.speaker) {
    parameters.diarization_enabled = true;
    if (typeof options.speaker === 'number') parameters.speaker_count = options.speaker;
  }

  const resp = await (options.fetchImpl ?? fetch)(`${DASHSCOPE_BASE}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_STT_MODEL,
      input: { file_urls: [fileUrl] },
      parameters,
    }),
    signal: options.signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DashScope 提交失败 (HTTP ${resp.status}): ${safeUpstreamError(text)}`);
  }

  const data = await resp.json() as TranscriptionTaskResponse;
  const taskId = data.output?.task_id;
  if (!taskId) {
    throw new Error(`DashScope 响应异常：缺少 task_id${data.request_id ? `（request_id=${data.request_id}）` : ''}`);
  }
  return taskId;
}

async function pollTranscription(
  taskId: string,
  apiKey: string,
  options: SttOptions,
): Promise<TranscriptionTaskResponse> {
  const startTime = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;

  while (true) {
    throwIfAborted(options.signal);
    const elapsed = Date.now() - startTime;
    if (elapsed > POLL_TIMEOUT_MS) {
      throw new Error(`STT 转写超时（已等待 ${Math.round(elapsed / 1000)}s）`);
    }

    const resp = await fetchImpl(`${DASHSCOPE_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: options.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`DashScope 查询失败 (HTTP ${resp.status}): ${safeUpstreamError(text)}`);
    }

    const data = await resp.json() as TranscriptionTaskResponse;
    const status = data.output?.task_status;
    if (status === 'SUCCEEDED') return data;
    if (status === 'FAILED') {
      const detail = [data.output?.code, data.output?.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(': ');
      throw new Error(`DashScope 转写失败${detail ? `：${safeUpstreamError(detail)}` : ''}`);
    }
    await abortableDelay(POLL_INTERVAL_MS, options.signal);
  }
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

function formatSentence(sentence: TranscriptionSentence, options: SttOptions): string {
  const parts: string[] = [];
  if (options.timestamps) parts.push(`[${formatTimestamp(sentence.begin_time ?? 0)}]`);
  if (options.speaker) {
    const speaker = sentence.speaker_id ?? sentence.speaker ?? sentence.spk_id;
    if (speaker !== undefined && speaker !== null && String(speaker).trim()) {
      parts.push(`[说话人${String(speaker).trim()}]`);
    }
  }
  const text = sentence.text?.trim() ?? '';
  return parts.length > 0 ? `${parts.join(' ')} ${text}`.trimEnd() : text;
}

async function fetchTranscriptionResult(
  result: TranscriptionTaskResponse,
  options: SttOptions,
): Promise<{ text: string; durationMs: number }> {
  const results = result.output?.results;
  if (!results?.length) return { text: '', durationMs: 0 };

  const lines: string[] = [];
  let maxEndTime = 0;
  for (const fileResult of results) {
    const transcriptionUrl = fileResult.transcription_url;
    if (!transcriptionUrl) continue;
    const resp = await fetchTrustedResult(transcriptionUrl, options);
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`DashScope 结果下载失败 (HTTP ${resp.status}): ${safeUpstreamError(body)}`);
    }

    const detail = await resp.json() as TranscriptionDetail;
    for (const transcript of detail.transcripts ?? []) {
      for (const sentence of transcript.sentences ?? []) {
        const line = formatSentence(sentence, options);
        if (line) lines.push(line);
        if (typeof sentence.end_time === 'number') maxEndTime = Math.max(maxEndTime, sentence.end_time);
      }
    }
  }

  return { text: lines.join('\n'), durationMs: maxEndTime };
}

/**
 * 语音转文字。保持原有 speechToText(path, config) 调用兼容，第三个 options 可选。
 * 输入可以是本地文件路径，也可以是 http/https 直链。
 */
export async function speechToText(
  input: string,
  config: SttConfig,
  options: SttOptions = {},
): Promise<SttResult> {
  if (!config.apiKey) throw new Error('STT 配置不完整: 缺少 apiKey');

  const remote = isHttpUrl(input);
  let ossClient: OSS | undefined;
  let ossKey: string | undefined;
  let fileUrl = input;

  try {
    throwIfAborted(options.signal);
    if (!remote) {
      if (!config.ossAccessKeyId || !config.ossAccessKeySecret) {
        throw new Error('STT 配置不完整: 转写本地文件时缺少 OSS 凭证');
      }
      const fileStat = await stat(input);
      if (!fileStat.isFile()) throw new Error(`STT 输入不是文件: ${input}`);
      if (fileStat.size > MAX_LOCAL_FILE_BYTES) {
        throw new Error(`STT 本地文件超过 2GB 上限: ${basename(input)}`);
      }

      ossClient = createOssClient(config);
      ossKey = await uploadToOss(ossClient, input);
      throwIfAborted(options.signal);
      fileUrl = ossClient.signatureUrl(ossKey, { expires: 86400 });
    }

    const taskId = await submitTranscription(fileUrl, config, options);
    const taskResult = await pollTranscription(taskId, config.apiKey, options);
    const { text, durationMs } = await fetchTranscriptionResult(taskResult, options);
    return { text, duration: durationMs };
  } finally {
    if (ossClient && ossKey) await deleteFromOss(ossClient, ossKey, options.onCleanupError);
  }
}

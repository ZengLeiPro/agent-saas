/**
 * STT (Speech-to-Text) 核心模块
 * 使用阿里云百炼 DashScope 录音文件识别 API（fun-asr / paraformer-v2）
 *
 * 流程: 读取 WAV → 上传 OSS → 提交 DashScope 转写任务 → 轮询结果 → 清理 OSS
 *
 * DashScope 文档: https://help.aliyun.com/zh/model-studio/recording-file-recognition
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import OSS from 'ali-oss';

// ============== 类型定义 ==============

/** STT 配置 */
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
  /** OSS Endpoint */
  ossEndpoint?: string;
}

/** STT 识别结果 */
export interface SttResult {
  /** 识别出的文本 */
  text: string;
  /** 音频时长（毫秒） */
  duration: number;
}

// ============== 常量 ==============

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
const DEFAULT_MODEL = 'fun-asr';
const DEFAULT_BUCKET = 'ky-azeroth-upload';
const DEFAULT_ENDPOINT = 'https://oss-cn-shenzhen.aliyuncs.com';

/** 轮询间隔 */
const POLL_INTERVAL_MS = 3_000;
/** 轮询超时（10 分钟，覆盖 30 分钟录音的处理时间） */
const POLL_TIMEOUT_MS = 600_000;

// ============== OSS 操作 ==============

function createOssClient(config: SttConfig): OSS {
  return new OSS({
    region: (config.ossEndpoint || DEFAULT_ENDPOINT).replace('https://', '').replace('.aliyuncs.com', ''),
    accessKeyId: config.ossAccessKeyId,
    accessKeySecret: config.ossAccessKeySecret,
    bucket: config.ossBucket || DEFAULT_BUCKET,
  });
}

async function uploadToOss(
  client: OSS,
  filePath: string,
): Promise<string> {
  const filename = basename(filePath);
  const ossKey = `tmp/stt/${Date.now()}_${filename}`;
  await client.put(ossKey, filePath);
  // 生成签名 URL，24 小时有效
  const url = client.signatureUrl(ossKey, { expires: 86400 });
  return ossKey;
}

async function getSignedUrl(client: OSS, ossKey: string): Promise<string> {
  return client.signatureUrl(ossKey, { expires: 86400 });
}

async function deleteFromOss(client: OSS, ossKey: string): Promise<void> {
  try {
    await client.delete(ossKey);
  } catch {
    // 清理失败不影响主流程
  }
}

// ============== DashScope API ==============

interface TranscriptionTaskResponse {
  request_id: string;
  output: {
    task_id: string;
    task_status: string;
    results?: Array<{
      file_url: string;
      transcription_url?: string;
    }>;
  };
}

async function submitTranscription(
  fileUrl: string,
  config: SttConfig,
): Promise<string> {
  const model = config.model || DEFAULT_MODEL;
  const resp = await fetch(`${DASHSCOPE_BASE}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: {
        file_urls: [fileUrl],
      },
      parameters: {
        language_hints: ['zh', 'en'],
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DashScope 提交失败 (HTTP ${resp.status}): ${text}`);
  }

  const data = await resp.json() as TranscriptionTaskResponse;
  if (!data.output?.task_id) {
    throw new Error(`DashScope 响应异常: ${JSON.stringify(data)}`);
  }

  return data.output.task_id;
}

async function pollTranscription(
  taskId: string,
  apiKey: string,
): Promise<TranscriptionTaskResponse> {
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > POLL_TIMEOUT_MS) {
      throw new Error(`STT 转写超时（已等待 ${Math.round(elapsed / 1000)}s）`);
    }

    const resp = await fetch(`${DASHSCOPE_BASE}/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`DashScope 查询失败 (HTTP ${resp.status}): ${text}`);
    }

    const data = await resp.json() as TranscriptionTaskResponse;
    const status = data.output?.task_status;

    if (status === 'SUCCEEDED') {
      return data;
    }

    if (status === 'FAILED') {
      throw new Error(`DashScope 转写失败: ${JSON.stringify(data.output)}`);
    }

    // PENDING / RUNNING → 继续等
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface TranscriptionDetail {
  transcripts?: Array<{
    sentences?: Array<{
      text: string;
      begin_time?: number;
      end_time?: number;
    }>;
  }>;
}

async function fetchTranscriptionResult(
  result: TranscriptionTaskResponse,
): Promise<{ text: string; durationMs: number }> {
  const results = result.output?.results;
  if (!results || results.length === 0) {
    return { text: '', durationMs: 0 };
  }

  const allTexts: string[] = [];
  let maxEndTime = 0;

  for (const fileResult of results) {
    const transUrl = fileResult.transcription_url;
    if (!transUrl) continue;

    const resp = await fetch(transUrl);
    if (!resp.ok) continue;

    const detail = await resp.json() as TranscriptionDetail;
    const transcripts = detail.transcripts || [];

    for (const t of transcripts) {
      for (const s of t.sentences || []) {
        const text = s.text?.trim();
        if (text) {
          allTexts.push(text);
        }
        if (s.end_time && s.end_time > maxEndTime) {
          maxEndTime = s.end_time;
        }
      }
    }
  }

  return {
    text: allTexts.join(''),
    durationMs: maxEndTime,
  };
}

// ============== 导出函数 ==============

/**
 * 语音转文字
 *
 * 读取 WAV 文件 → 上传 OSS → DashScope 录音文件识别 → 返回文本
 *
 * @param wavFilePath - WAV 音频文件路径
 * @param config - STT 配置
 * @returns 识别结果
 */
export async function speechToText(
  wavFilePath: string,
  config: SttConfig,
): Promise<SttResult> {
  const { apiKey, ossAccessKeyId, ossAccessKeySecret } = config;

  if (!apiKey) {
    throw new Error('STT 配置不完整: 缺少 apiKey');
  }
  if (!ossAccessKeyId || !ossAccessKeySecret) {
    throw new Error('STT 配置不完整: 缺少 OSS 凭证');
  }

  const model = config.model || DEFAULT_MODEL;
  const ossClient = createOssClient(config);
  let ossKey: string | undefined;

  try {
    // 1. 上传到 OSS
    console.log(`[STT] uploading ${basename(wavFilePath)} to OSS...`);
    ossKey = await uploadToOss(ossClient, wavFilePath);
    const fileUrl = await getSignedUrl(ossClient, ossKey);
    console.log('[STT] upload complete');

    // 2. 提交转写任务
    console.log(`[STT] submitting transcription (model=${model})...`);
    const taskId = await submitTranscription(fileUrl, config);
    console.log(`[STT] task submitted: ${taskId}`);

    // 3. 轮询等待结果
    console.log('[STT] polling for result...');
    const taskResult = await pollTranscription(taskId, apiKey);
    console.log('[STT] transcription complete');

    // 4. 提取文本
    const { text, durationMs } = await fetchTranscriptionResult(taskResult);
    console.log(`[STT] result: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}" (duration=${durationMs}ms)`);

    return { text, duration: durationMs };
  } finally {
    // 5. 清理 OSS 临时文件
    if (ossKey) {
      await deleteFromOss(ossClient, ossKey);
    }
  }
}

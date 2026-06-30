/**
 * TTS (Text-to-Speech) 核心模块
 * 使用豆包（火山引擎）TTS V3 服务将文本转换为语音
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

// ============== 类型定义 ==============

/** 豆包音色名称 */
export type DoubaoVoiceName = 'cancan' | 'vivi' | 'tianmei' | 'kefu' | 'wennuan' | 'jieshuo';

/** 音色配置映射 */
export interface VoiceConfig {
  [key: string]: string;
}

/** TTS 配置 */
export interface TTSConfig {
  /** 豆包应用 ID */
  appId: string;
  /** 豆包 API Token */
  token: string;
  /** 音色名称（默认 cancan） */
  voice?: DoubaoVoiceName | string;
  /** 语速 0.5-2.0（默认 1.2） */
  speed?: number;
  /** 音量 0.5-2.0（默认 1.0） */
  volume?: number;
}

/** TTS 全局配置（从 config.json 读取） */
export interface TTSGlobalConfig {
  doubaoAppId: string;
  doubaoApiKey: string;
  doubaoCluster?: string;
  defaultVoice?: string;
  defaultSpeed?: number;
}

/** HTTP 响应结构 */
interface HttpResponse {
  statusCode: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** TTS API 响应结构 */
interface TTSApiResponse {
  code?: number;
  message?: string;
  data?: string;
}

/** 文本转语音结果 */
export interface TextToSpeechResult {
  /** 输出文件路径 */
  filePath: string;
  /** 音频时长（毫秒） */
  duration: number;
  /** 文件大小（字节） */
  size: number;
}

// ============== 常量 ==============

/** 豆包音色配置 */
export const DOUBAO_VOICES: VoiceConfig = {
  'cancan': 'zh_female_cancan_mars_bigtts',       // 女-灿灿（默认，甜美）
  'vivi': 'zh_female_vv_uranus_bigtts',           // 女-vivi（活力）
  'tianmei': 'zh_female_tianmeixiaoyuan_moon_bigtts',  // 女-甜美小源
  'kefu': 'zh_female_kefunvsheng_mars_bigtts',    // 女-客服女声
  'wennuan': 'zh_male_wennuanahu_moon_bigtts',    // 男-温暖阿虎
  'jieshuo': 'zh_male_jieshuoxiaoming_moon_bigtts' // 男-解说小明
};

// 注意：TTS 全局配置不再从 utils/config.ts 全局单例获取，
// 而是由调用方通过 textToSpeechWithConfig() 参数直接传入。

// ============== 内部函数 ==============

/**
 * 生成 UUID
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 发起 HTTPS 请求
 */
function httpsRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> },
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: buffer
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ============== 导出函数 ==============

/**
 * 豆包 TTS 合成语音
 * @param text - 要合成的文本
 * @param config - 配置
 * @returns 音频数据 Buffer
 */
export async function synthesize(text: string, config: TTSConfig): Promise<Buffer> {
  const {
    appId,
    token,
    voice = 'cancan',
    speed = 1.2,
    volume = 1.0
  } = config;

  if (!appId || !token) {
    throw new Error('缺少 appId 或 token 配置');
  }

  const voiceType = DOUBAO_VOICES[voice] || voice;
  const reqId = generateUUID();

  // 转换语速参数 [-50, 100]
  const speechRate = Math.max(-50, Math.min(100, Math.round((speed - 1.0) * 100)));
  const loudnessRate = Math.max(-50, Math.min(100, Math.round((volume - 1.0) * 100)));

  const body = JSON.stringify({
    user: { uid: 'tts_user' },
    req_params: {
      text: text,
      speaker: voiceType,
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
        speech_rate: speechRate,
        loudness_rate: loudnessRate
      }
    }
  });

  const response = await httpsRequest(
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': appId,
        'X-Api-Access-Key': token,
        'X-Api-Resource-Id': 'seed-tts-1.0',
        'X-Api-Request-Id': reqId
      }
    },
    body
  );

  if (response.statusCode !== 200) {
    throw new Error(`TTS 请求失败: HTTP ${response.statusCode}`);
  }

  // 解析流式响应
  const audioChunks: Buffer[] = [];
  const lines = response.body.toString().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const result: TTSApiResponse = JSON.parse(line);
      if (result.code && result.code !== 0 && result.code !== 20000000) {
        throw new Error(`TTS Error: ${result.message || 'Unknown'}, code: ${result.code}`);
      }
      if (result.data) {
        audioChunks.push(Buffer.from(result.data, 'base64'));
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }

  return Buffer.concat(audioChunks);
}

/**
 * 获取 MP3 时长
 * 优先通过解析 MP3 帧头获取精确时长，失败时降级到固定比特率估算。
 * @param buffer - 音频 Buffer
 * @returns 时长（毫秒）
 */
export function estimateDuration(buffer: Buffer): number {
  const parsed = parseMp3Duration(buffer);
  if (parsed > 0) return parsed;
  // 降级：豆包 TTS 输出 64kbps = 8000 bytes/sec
  return Math.ceil((buffer.length / 8000) * 1000);
}

// MP3 MPEG1 Layer3 比特率表（kbps，index 0 表示无效）
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
// MP3 MPEG1 采样率表（Hz）
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000, 0];
// MP3 MPEG2/2.5 Layer3 比特率表
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// MP3 MPEG2 采样率表
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000, 0];
// MP3 MPEG2.5 采样率表
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000, 0];

/**
 * 通过扫描 MP3 帧头计算精确时长
 * 支持 MPEG1/2/2.5 Layer3，跳过 ID3v2 标签
 */
function parseMp3Duration(buffer: Buffer): number {
  if (buffer.length < 10) return 0;

  let offset = 0;

  // 跳过 ID3v2 标签
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) { // "ID3"
    const size = ((buffer[6] & 0x7F) << 21) | ((buffer[7] & 0x7F) << 14)
               | ((buffer[8] & 0x7F) << 7) | (buffer[9] & 0x7F);
    offset = 10 + size;
  }

  let totalSamples = 0;
  let sampleRate = 0;
  let frameCount = 0;

  while (offset + 4 <= buffer.length) {
    // 查找帧同步字 (11 bits: 0xFFE0)
    if (buffer[offset] !== 0xFF || (buffer[offset + 1] & 0xE0) !== 0xE0) {
      offset++;
      continue;
    }

    const header = buffer.readUInt32BE(offset);
    const mpegVersion = (header >> 19) & 0x03; // 00=2.5, 01=reserved, 10=2, 11=1
    const layer = (header >> 17) & 0x03;        // 01=Layer3
    const bitrateIdx = (header >> 12) & 0x0F;
    const sampleRateIdx = (header >> 10) & 0x03;
    const padding = (header >> 9) & 0x01;

    // 仅处理 Layer3
    if (layer !== 0x01 || mpegVersion === 0x01 || bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) {
      offset++;
      continue;
    }

    let bitrate: number;
    let sr: number;
    let samplesPerFrame: number;

    if (mpegVersion === 0x03) {
      // MPEG1
      bitrate = MPEG1_L3_BITRATES[bitrateIdx] * 1000;
      sr = MPEG1_SAMPLE_RATES[sampleRateIdx];
      samplesPerFrame = 1152;
    } else {
      // MPEG2 / MPEG2.5
      bitrate = MPEG2_L3_BITRATES[bitrateIdx] * 1000;
      sr = mpegVersion === 0x02 ? MPEG2_SAMPLE_RATES[sampleRateIdx] : MPEG25_SAMPLE_RATES[sampleRateIdx];
      samplesPerFrame = 576;
    }

    if (bitrate === 0 || sr === 0) {
      offset++;
      continue;
    }

    if (sampleRate === 0) sampleRate = sr;
    totalSamples += samplesPerFrame;
    frameCount++;

    // 计算帧大小并跳到下一帧
    const frameSize = Math.floor((samplesPerFrame / 8) * bitrate / sr) + padding;
    if (frameSize < 1) {
      offset++;
      continue;
    }
    offset += frameSize;
  }

  if (frameCount === 0 || sampleRate === 0) return 0;
  return Math.ceil((totalSamples / sampleRate) * 1000);
}

/**
 * 文本转语音并保存到文件
 * @param text - 要转换的文本
 * @param config - TTS 配置
 * @param outputPath - 输出文件路径
 * @returns 转换结果
 */
export async function textToSpeech(
  text: string,
  config: TTSConfig,
  outputPath: string
): Promise<TextToSpeechResult> {
  const audioBuffer = await synthesize(text, config);

  // 确保输出目录存在
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, audioBuffer);

  const duration = estimateDuration(audioBuffer);

  return {
    filePath: outputPath,
    duration: duration,
    size: audioBuffer.length
  };
}

/**
 * 使用外部传入的全局配置进行文本转语音
 * @param text - 要转换的文本
 * @param outputPath - 输出文件路径
 * @param globalConfig - TTS 全局配置（从 config.json 读取后传入）
 * @param options - 可选参数覆盖
 * @returns 转换结果
 */
export async function textToSpeechWithConfig(
  text: string,
  outputPath: string,
  globalConfig: TTSGlobalConfig,
  options?: { voice?: string; speed?: number; volume?: number }
): Promise<TextToSpeechResult> {
  const config: TTSConfig = {
    appId: globalConfig.doubaoAppId,
    token: globalConfig.doubaoApiKey,
    voice: options?.voice || globalConfig.defaultVoice || 'cancan',
    speed: options?.speed || globalConfig.defaultSpeed || 1.2,
    volume: options?.volume || 1.0
  };

  return textToSpeech(text, config, outputPath);
}

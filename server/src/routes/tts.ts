/**
 * TTS Route
 *
 * 提供 Web 端文本转语音 API。
 * 直接调用 synthesize() 返回 MP3 Buffer，不写临时文件。
 */

import { Router } from 'express';
import { synthesize, estimateDuration } from '../integrations/tts/ttsClient.js';
import { chatLogger } from '../utils/logger.js';

/** 窄 Config 接口 — 只声明自己需要的最小配置 */
export interface TtsRouterConfig {
  tts?: {
    doubaoAppId: string;
    doubaoApiKey: string;
    defaultVoice?: string;
    defaultSpeed?: number;
  };
}

const MAX_TEXT_LENGTH = 5000;

/**
 * 剥离 Markdown 格式标记，返回适合 TTS 朗读的纯文本。
 * 保留语义内容（链接文字、图片 alt、列表项文本等），
 * 去除纯视觉/结构标记（#、**、``、|、--- 等）。
 */
function stripMarkdownForTts(md: string): string {
  let text = md;

  // 代码块 → 保留内容
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const lines = m.split('\n');
    return lines.slice(1, -1).join('\n');
  });

  // 行内代码
  text = text.replace(/`([^`]+)`/g, '$1');

  // 图片 ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 链接 [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 标题 # → 去掉 #
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 粗斜体 ***text*** 或 ___text___
  text = text.replace(/(\*{3}|_{3})(.+?)\1/g, '$2');

  // 粗体 **text** 或 __text__
  text = text.replace(/(\*{2}|_{2})(.+?)\1/g, '$2');

  // 斜体 *text* 或 _text_（不匹配单词中间的下划线）
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

  // 删除线 ~~text~~
  text = text.replace(/~~(.+?)~~/g, '$1');

  // 引用 > 前缀
  text = text.replace(/^>\s?/gm, '');

  // 水平线
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // 无序列表标记 - / * / +
  text = text.replace(/^[\t ]*[-*+]\s+/gm, '');

  // 有序列表标记 1. 2. 等
  text = text.replace(/^[\t ]*\d+\.\s+/gm, '');

  // 表格：去掉分隔行，去掉行首尾 |，内部 | → 逗号
  text = text.replace(/^\|[-:\s|]+\|\s*$/gm, '');
  text = text.replace(/^\|(.+)\|$/gm, (_m, inner: string) =>
    inner.replace(/\|/g, '，').trim(),
  );

  // 连续空行压缩
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

export function createTtsRouter(config: TtsRouterConfig): Router {
  const router = Router();

  router.post('/tts', async (req, res) => {
    if (!config.tts) {
      res.status(503).json({ error: 'TTS not configured' });
      return;
    }

    const { text, voice, speed } = req.body ?? {};

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: `text too long (max ${MAX_TEXT_LENGTH} chars)` });
      return;
    }

    try {
      const audioBuffer = await synthesize(stripMarkdownForTts(text), {
        appId: config.tts.doubaoAppId,
        token: config.tts.doubaoApiKey,
        voice: voice || config.tts.defaultVoice || 'cancan',
        speed: speed || config.tts.defaultSpeed || 1.2,
      });

      const duration = estimateDuration(audioBuffer);

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioBuffer.length);
      res.setHeader('X-TTS-Duration-Ms', String(duration));
      res.send(audioBuffer);
    } catch (err) {
      chatLogger.error('TTS synthesis failed:', err);
      res.status(500).json({ error: 'TTS synthesis failed' });
    }
  });

  return router;
}

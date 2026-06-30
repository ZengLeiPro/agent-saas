#!/usr/bin/env tsx
/**
 * 批量生成会话标题
 *
 * 扫描所有 transcript，对没有标题的会话调用 LLM 生成标题。
 *
 * 用法：
 *   cd server && npx tsx src/scripts/batchGenerateTitles.ts [--dry-run] [--concurrency=5]
 *
 * 选项：
 *   --dry-run       只扫描统计，不实际生成
 *   --concurrency=N LLM 并发数（默认 3）
 */

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { loadAppConfig } from '../app/config.js';
import { resolveModelRef } from '../app/models.js';
import { generateTitle, type TitleGeneratorConfig } from '../agent/titleGenerator.js';
import { readSessionMeta, updateSessionMeta } from '../data/transcripts/meta.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT, isValidSessionId } from '../data/transcripts/projectKey.js';

// ── 配置 ──────────────────────────────────────────────────

const PROJECTS_ROOT = process.env.AGENT_TRANSCRIPTS_ROOT || AGENT_LEGACY_TRANSCRIPTS_ROOT;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) || 3 : 3;

// ── 检测 sidechain（子agent）会话 ────────────────────────

async function isSidechainSession(transcriptPath: string): Promise<boolean> {
  try {
    const fd = await fs.open(transcriptPath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    await fd.close();
    if (bytesRead === 0) return false;
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    const obj = JSON.parse(firstLine);
    return !!obj.isSidechain;
  } catch {
    return false;
  }
}

// ── 从 JSONL 提取首条用户消息 + 首条/末条助手回复 ─────────

interface ExtractedMessages {
  firstUserMessage: string | null;
  firstAssistantReply: string | null;
  lastAssistantReply: string | null;
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b?.type === 'text');
    if (textBlock && typeof textBlock.text === 'string') return textBlock.text;
  }
  return null;
}

/** 剥离 memory-context 和时间戳前缀 */
function cleanUserMessage(text: string): string {
  // 剥离 <memory-context>...</memory-context>
  let cleaned = text.replace(/^<memory-context>[\s\S]*?<\/memory-context>\s*/, '');
  // 剥离钉钉格式前缀
  const marker = '[用户消息]';
  const idx = cleaned.indexOf(marker);
  if (idx >= 0) cleaned = cleaned.slice(idx + marker.length).trim();
  // 剥离时间戳前缀
  cleaned = cleaned.replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, '');
  return cleaned;
}

/** Skill 上下文检测 */
function isSkillContext(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('Base directory for this skill:')) return true;
  if (t.includes('\n# gog\n') && t.includes('Use `gog`')) return true;
  if (t.includes('ARGUMENTS:') && t.includes('Base directory for this skill:')) return true;
  return false;
}

async function extractMessages(transcriptPath: string): Promise<ExtractedMessages> {
  const result: ExtractedMessages = {
    firstUserMessage: null,
    firstAssistantReply: null,
    lastAssistantReply: null,
  };

  let rl: readline.Interface;
  try {
    rl = readline.createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return result;
  }

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    // 首条用户消息
    if (!result.firstUserMessage && obj?.type === 'user' && obj?.message?.content != null) {
      const raw = extractTextFromContent(obj.message.content);
      if (raw && !isSkillContext(raw)) {
        result.firstUserMessage = cleanUserMessage(raw).slice(0, 1000);
      }
    }

    // 助手回复
    if (obj?.type === 'assistant' && obj?.message?.content) {
      const text = extractTextFromContent(obj.message.content);
      if (text) {
        if (!result.firstAssistantReply) {
          result.firstAssistantReply = text.slice(0, 1000);
        }
        result.lastAssistantReply = text.slice(0, 1000);
      }
    }
  }

  return result;
}

// ── 扫描所有会话 ─────────────────────────────────────────

interface SessionInfo {
  sessionId: string;
  transcriptPath: string;
}

async function scanAllSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      // 兼容旧版 agent-xxxxxxx 格式和 UUID 格式
      if (!isValidSessionId(sessionId) && !/^agent-[0-9a-f]+$/.test(sessionId)) continue;

      try {
        const stat = await fs.stat(fullPath);
        if (stat.size === 0) continue;
      } catch { continue; }

      sessions.push({ sessionId, transcriptPath: fullPath });
    }
  }
  await walk(PROJECTS_ROOT);

  return sessions;
}

// ── 并发控制 ──────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log('=== 批量生成会话标题 ===');
  if (dryRun) console.log('(dry-run 模式，不实际生成)');
  console.log(`并发数: ${concurrency}`);
  console.log();

  // 1. 构建 titleGeneratorConfig
  const processCwd = path.resolve(import.meta.dirname, '../..');
  const config = loadAppConfig(processCwd);

  let titleConfig: TitleGeneratorConfig;

  if (config.titleGenerator?.model && config.models) {
    const resolved = resolveModelRef(config.models, config.titleGenerator.model);
    if (resolved) {
      titleConfig = { model: resolved.model, connection: resolved.connection };
      console.log(`模型: ${resolved.model} (from "${config.titleGenerator.model}")`);
    } else {
      console.error(`模型引用 "${config.titleGenerator.model}" 无法解析，退出`);
      process.exit(1);
    }
  } else {
    const model = process.env.OPENAI_DEFAULT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    titleConfig = { model };
    console.log(`模型: ${model} (default)`);
  }

  // 2. 扫描所有会话
  console.log('\n扫描会话...');
  const allSessions = await scanAllSessions();
  console.log(`总会话数: ${allSessions.length}`);

  // 3. 过滤需要生成标题的会话
  const needTitle: SessionInfo[] = [];
  let skippedCustom = 0;
  let skippedGenerated = 0;
  let skippedCron = 0;
  let skippedSidechain = 0;

  for (const session of allSessions) {
    // 跳过子agent（sidechain）会话
    if (await isSidechainSession(session.transcriptPath)) { skippedSidechain++; continue; }
    const meta = await readSessionMeta(session.transcriptPath);
    if (meta?.channel === 'cron') { skippedCron++; continue; }
    if (meta?.customTitle) { skippedCustom++; continue; }
    if (meta?.generatedTitle) { skippedGenerated++; continue; }
    needTitle.push(session);
  }

  console.log(`子agent会话: ${skippedSidechain} (跳过)`);
  console.log(`cron 任务会话: ${skippedCron} (跳过)`);
  console.log(`已有自定义标题: ${skippedCustom} (跳过)`);
  console.log(`已有生成标题: ${skippedGenerated} (跳过)`);
  console.log(`需要生成: ${needTitle.length}`);

  if (dryRun || needTitle.length === 0) {
    console.log('\n完成。');
    process.exit(0);
  }

  // 4. 批量生成
  console.log(`\n开始生成 (并发=${concurrency})...\n`);

  let success = 0;
  let failed = 0;
  let noContent = 0;
  const startTime = Date.now();

  await runWithConcurrency(needTitle, concurrency, async (session, i) => {
    const progress = `[${i + 1}/${needTitle.length}]`;

    try {
      const messages = await extractMessages(session.transcriptPath);

      if (!messages.firstUserMessage) {
        noContent++;
        console.log(`${progress} ${session.sessionId} - 跳过（无用户消息）`);
        return;
      }

      // 优先用首条助手回复，回退到末条
      const assistantReply = messages.firstAssistantReply || messages.lastAssistantReply || '';

      const title = await generateTitle(messages.firstUserMessage, assistantReply, titleConfig);

      if (title) {
        await updateSessionMeta(session.transcriptPath, { generatedTitle: title });
        success++;
        console.log(`${progress} ${session.sessionId} - ✓ ${title}`);
      } else {
        failed++;
        console.log(`${progress} ${session.sessionId} - ✗ 生成失败（返回空）`);
      }
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`${progress} ${session.sessionId} - ✗ ${reason}`);
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 完成 ===`);
  console.log(`成功: ${success}  失败: ${failed}  无内容跳过: ${noContent}`);
  console.log(`耗时: ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

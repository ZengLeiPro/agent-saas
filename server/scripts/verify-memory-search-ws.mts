/**
 * Verify: 真实 WebSocket 跑 MemorySearch function tool。
 *
 * 目的：
 *   - 让模型在副本 Web admin 通道里真正调用 `MemorySearch` 工具，
 *     确认 tool_start/tool_input/tool_result 事件链与 transcript JSONL 都正确。
 *   - 同时确认 runtime event store 与 transcript 都落盘。
 *
 * 运行方式：
 *   tsx server/scripts/verify-memory-search-ws.mts
 *   tsx server/scripts/verify-memory-search-ws.mts --model gpt-5.5
 *   VERIFY_WS_MODEL=gpt-5.5 tsx server/scripts/verify-memory-search-ws.mts
 *
 * 前置：
 *   - 副本 server 已在 127.0.0.1:3200 运行
 *   - config.json 中 auth.jwtSecret 与 memory.index.enabled=true
 *
 * 输出：每轮一份 verdict 摘要；任一关键断言失败时进程退出码非零。
 *
 * 注意：MemoryIndexService 在副本里是 lazy 的——只有第一次 MemorySearch
 *      工具被调用时才会创建 Indexer + 启动 initial sync，所以第一轮可能因
 *      sqlite 尚未填充而返回 "未找到"。脚本会自动重试第二轮。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { parse as parseJsonc } from 'jsonc-parser';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

interface Envelope {
  eventId?: number;
  seq?: number;
  data: Record<string, unknown>;
}

interface Config {
  models?: {
    default?: string;
    groups?: Array<{
      id?: string;
      models?: Array<{ id?: string; value?: string; name?: string }>;
    }>;
  };
}

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const TRANSCRIPT_ROOT = join(
  process.env.HOME ?? '',
  '.agent-saas/legacy-transcripts/pantheon/admin',
);
const WS_URL = 'ws://127.0.0.1:3200/ws';
const TURN_TIMEOUT_MS = 90_000;

interface Round {
  sessionId: string | null;
  events: Envelope[];
  toolCalls: Array<{ name: string; toolId: string; input: string; result?: string }>;
  finalText: string;
  errors: string[];
}

interface ResolvedWebModel {
  input: string;
  modelRef: string;
  modelValue: string;
}

function loadJwtSecret(): string {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  // config.json 是 JSONC——直接正则抓 auth.jwtSecret，不再整体剥注释（会误伤 URL 里的 //）
  const m = raw.match(/"jwtSecret"\s*:\s*"([^"]+)"/);
  if (!m) {
    throw new Error('auth.jwtSecret not found in config.json');
  }
  return m[1]!;
}

function loadConfig(): Config {
  return parseJsonc(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
}

function parseModelArg(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--model' || arg === '-m') {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a model value`);
      return value;
    }
    if (arg.startsWith('--model=')) return arg.slice('--model='.length);
  }
  return process.env.VERIFY_WS_MODEL || process.env.MODEL;
}

function resolveWebModel(inputArg: string | undefined): ResolvedWebModel {
  const config = loadConfig();
  const input = inputArg || config.models?.default;
  if (!input) {
    throw new Error('No model specified and config.models.default is missing.');
  }

  const candidates: ResolvedWebModel[] = [];
  for (const group of config.models?.groups ?? []) {
    if (!group.id) continue;
    for (const model of group.models ?? []) {
      if (!model.id || !model.value) continue;
      const modelRef = `${group.id}/${model.id}`;
      if (input === modelRef || input === model.id || input === model.value) {
        candidates.push({ input, modelRef, modelValue: model.value });
      }
    }
  }

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`Model "${input}" is ambiguous in config.json: ${candidates.map((c) => c.modelRef).join(', ')}`);
  }

  const configured = (config.models?.groups ?? [])
    .flatMap((group) => (group.models ?? []).map((model) => `${group.id}/${model.id}=${model.value}`))
    .join(', ');
  throw new Error(
    `Model "${input}" is not configured in config.json. WebSocket chat requires a configured model ref; configured models: ${configured}`,
  );
}

function loadAdminUser(): { id: string; username: string } {
  const usersPath = join(PROJECT_ROOT, 'server', 'data', 'users.json');
  const parsed = JSON.parse(readFileSync(usersPath, 'utf-8'));
  const admin = (parsed.users as Array<{ id: string; username: string; role: string }>).find((u) => u.role === 'admin');
  if (!admin) throw new Error('No admin user found in data/users.json');
  return { id: admin.id, username: admin.username };
}

async function runChatRound(prompt: string, resumeSessionId: string | null, modelRef: string): Promise<Round> {
  const secret = loadJwtSecret();
  const user = loadAdminUser();
  const token = jwt.sign({ sub: user.id, username: user.username, role: 'admin' }, secret, { expiresIn: '5m' });
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  const round: Round = { sessionId: resumeSessionId, events: [], toolCalls: [], finalText: '', errors: [] };

  const toolById = new Map<string, { name: string; input: string; result?: string }>();
  let textBuf = '';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      round.errors.push(`turn timeout after ${TURN_TIMEOUT_MS}ms`);
      try { ws.close(); } catch {}
      resolve();
    }, TURN_TIMEOUT_MS);

    ws.on('open', () => {
      const clientMsgId = randomUUID();
      const payload: Record<string, unknown> = {
        action: 'chat',
        client_msg_id: clientMsgId,
        message: prompt,
        model: modelRef,
      };
      if (resumeSessionId) payload.sessionId = resumeSessionId;
      ws.send(JSON.stringify(payload));
    });

    ws.on('error', (err) => {
      round.errors.push(`ws error: ${err.message}`);
      clearTimeout(timer);
      reject(err);
    });

    ws.on('message', (raw) => {
      let env: Envelope;
      try {
        env = JSON.parse(raw.toString()) as Envelope;
      } catch (err) {
        round.errors.push(`invalid envelope: ${err}`);
        return;
      }
      round.events.push(env);
      const data = env.data as Record<string, unknown>;
      const type = data?.type as string | undefined;
      if (type === 'session') {
        round.sessionId = data.sessionId as string;
      } else if (type === 'block_start') {
        if (data.blockType === 'tool_use' && typeof data.toolId === 'string' && typeof data.toolName === 'string') {
          toolById.set(data.toolId, { name: data.toolName, input: '' });
        }
      } else if (type === 'tool_input') {
        const id = data.toolId as string | undefined;
        const content = data.content as string | undefined;
        if (id && typeof content === 'string') {
          const entry = toolById.get(id);
          if (entry) entry.input += content;
        }
      } else if (type === 'tool_result') {
        const id = data.toolId as string | undefined;
        const result = data.result as string | undefined;
        if (id && toolById.has(id)) {
          const entry = toolById.get(id)!;
          entry.result = result ?? '';
        }
      } else if (type === 'text') {
        const content = data.content as string | undefined;
        if (typeof content === 'string') textBuf += content;
      } else if (type === 'done') {
        if (typeof data.error === 'string' && data.error) round.errors.push(`done error: ${data.error}`);
        round.finalText = textBuf;
        round.toolCalls = Array.from(toolById.entries()).map(([toolId, entry]) => ({
          toolId,
          ...entry,
        }));
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve();
      } else if (type === 'error') {
        round.errors.push(`server error: ${data.message}`);
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve();
      }
    });
  });

  return round;
}

function summarizeRound(label: string, round: Round): void {
  console.log(`\n=== ${label} ===`);
  console.log(`sessionId: ${round.sessionId}`);
  console.log(`finalText: ${round.finalText.replace(/\s+/g, ' ').slice(0, 200)}`);
  console.log(`toolCalls (${round.toolCalls.length}):`);
  for (const call of round.toolCalls) {
    console.log(`  - name=${call.name} id=${call.toolId} input=${call.input.slice(0, 120)}`);
    console.log(`    result=${(call.result ?? '').replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  if (round.errors.length) {
    console.log(`errors: ${round.errors.join(' | ')}`);
  }
}

function transcriptHas(sessionId: string, predicate: (line: Record<string, unknown>) => boolean): boolean {
  const path = join(TRANSCRIPT_ROOT, `${sessionId}.jsonl`);
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (predicate(obj)) return true;
    } catch {}
  }
  return false;
}

function runtimeEventFile(sessionId: string): string {
  return join(TRANSCRIPT_ROOT, `${sessionId}.runtime-events.jsonl`);
}

function runtimeEventHas(sessionId: string, predicate: (line: Record<string, unknown>) => boolean): boolean {
  const path = runtimeEventFile(sessionId);
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (predicate(obj)) return true;
    } catch {}
  }
  return false;
}

async function main(): Promise<void> {
  const selectedModel = resolveWebModel(parseModelArg());
  console.log(`[config] model input=${selectedModel.input}`);
  console.log(`[config] web modelRef=${selectedModel.modelRef}`);
  console.log(`[config] runtime model value=${selectedModel.modelValue}`);

  const prompt =
    '请使用 MemorySearch 工具检索一下「曾磊在开沿科技担任什么角色」以及「公司销售团队有哪些成员」，' +
    '然后只基于工具返回的内容用一两句话回答我。不要凭空回答。';

  console.log('[round 1] 触发 MemoryIndexer 创建 + initial sync …');
  const round1 = await runChatRound(prompt, null, selectedModel.modelRef);
  summarizeRound('Round 1', round1);

  const round1HasTool = round1.toolCalls.some((c) => c.name === 'MemorySearch');
  if (!round1HasTool) {
    console.error('[FAIL] Round 1 模型没有调用 MemorySearch；prompt 可能不够强或工具未注入。');
    process.exit(1);
  }

  console.log('\n[wait 20s] 等待 MemoryIndexer 完成首轮 sync（embedding + chunk）…');
  await sleep(20_000);

  console.log('\n[round 2] 复用同 sessionId，再次让模型查询同一事实，期望返回非空命中。');
  const round2 = await runChatRound(prompt, round1.sessionId, selectedModel.modelRef);
  summarizeRound('Round 2', round2);

  const round2Calls = round2.toolCalls.filter((c) => c.name === 'MemorySearch');
  if (round2Calls.length === 0) {
    console.error('[FAIL] Round 2 模型没有再次调用 MemorySearch。');
    process.exit(1);
  }
  const nonEmpty = round2Calls.find((c) => c.result && !c.result.startsWith('未找到匹配的记忆内容'));
  if (!nonEmpty) {
    console.error('[FAIL] Round 2 MemorySearch 仍返回空。可能 embedding API key 不可用或 MEMORY.md 为空。');
    process.exit(2);
  }

  // 内容粗校验
  const toolResultText = round2Calls.map((c) => c.result ?? '').join('\n');
  const roleHit = ['创始人', 'CEO'].find((kw) => toolResultText.includes(kw));
  const salesHits = ['陈育新', '黄思霖', '许锐宏', '彭一宁'].filter((kw) => toolResultText.includes(kw));
  if (!roleHit || salesHits.length < 2) {
    console.error('[FAIL] Round 2 MemorySearch 工具结果未包含足够的事实关键词。');
    console.error(`       roleHit=${roleHit ?? 'none'} salesHits=${salesHits.join(',') || 'none'}`);
    process.exit(3);
  }
  console.log(`[ok] Round 2 工具结果命中事实关键词: role=${roleHit}, sales=${salesHits.join(',')}`);

  // Transcript 落盘校验
  const sid = round2.sessionId!;
  const hasToolUse = transcriptHas(sid, (obj) => {
    if (obj.type !== 'assistant') return false;
    const msg = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
    return (msg?.content ?? []).some((c) => c.type === 'tool_use' && c.name === 'MemorySearch');
  });
  const hasToolResult = transcriptHas(sid, (obj) => {
    if (obj.type !== 'user') return false;
    const msg = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
    return (msg?.content ?? []).some((c) => c.type === 'tool_result');
  });
  if (!hasToolUse) {
    console.error('[FAIL] Round 2 transcript JSONL 中没有 MemorySearch tool_use 行。');
    process.exit(4);
  }
  if (!hasToolResult) {
    console.error('[FAIL] Round 2 transcript JSONL 中没有 tool_result 行。');
    process.exit(5);
  }
  console.log(`[ok] Transcript JSONL 包含 MemorySearch tool_use + tool_result`);

  // raw runtime canonical event log 校验
  const eventPath = runtimeEventFile(sid);
  try {
    const hasRuntimeToolCall = runtimeEventHas(sid, (obj) =>
      obj.type === 'assistant_tool_calls'
      && Array.isArray(obj.toolCalls)
      && obj.toolCalls.some((call) =>
        typeof call === 'object'
        && call !== null
        && (call as { name?: unknown }).name === 'MemorySearch',
      ),
    );
    const hasRuntimeToolResult = runtimeEventHas(sid, (obj) =>
      obj.type === 'tool_result' && obj.toolName === 'MemorySearch',
    );
    if (!hasRuntimeToolCall) {
      console.error(`[FAIL] raw runtime event log ${eventPath} 中没有 MemorySearch assistant_tool_calls。`);
      process.exit(6);
    }
    if (!hasRuntimeToolResult) {
      console.error(`[FAIL] raw runtime event log ${eventPath} 中没有 MemorySearch tool_result。`);
      process.exit(7);
    }
    console.log(`[ok] raw runtime event log 包含 MemorySearch assistant_tool_calls + tool_result`);
  } catch (err) {
    console.error(`[FAIL] 读取 raw runtime event log 失败: ${err}`);
    process.exit(8);
  }

  console.log('\n[PASS] MemorySearch 真实 WebSocket 验收通过。');
}

main().catch((err) => {
  console.error('[fatal] verify-memory-search-ws failed:', err);
  process.exit(99);
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { getTokenUsage } from '../data/transcripts/parse.js';

/**
 * getTokenUsage 的 contextTokens 口径回归测试。
 *
 * assertAllowedTranscriptPath 强校验路径必须在 AGENT_LEGACY_TRANSCRIPTS_ROOT 之下，
 * 无法用 os.tmpdir()。改在真实根下建 `__test__/<uuid>/` 子目录，afterEach 清理。
 *
 * 强化 B 语义（2026-07-05）：
 * - input_includes_cache 模式（Ark Responses+chain / OpenAI-compat）逐 leg 累加
 *   `(input - cache_read) + output`，cache_read=0 时锚定到 `input + output`。
 * - cache_tokens_separate 模式（Anthropic 原生）沿用老口径 = 最后一 leg 的 turnTotal。
 */
describe('getTokenUsage — contextTokens accounting', () => {
  const cleanupDirs = new Set<string>();
  let baseDir: string;

  beforeEach(async () => {
    // uuid 命名避免并发或历史残留冲撞
    const uuid = randomUuidLikeString();
    baseDir = join(AGENT_LEGACY_TRANSCRIPTS_ROOT, '__test__', uuid);
    await mkdir(baseDir, { recursive: true });
    cleanupDirs.add(baseDir);
  });

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    cleanupDirs.clear();
  });

  async function writeTranscript(sessionId: string, lines: object[]): Promise<string> {
    const file = join(baseDir, `${sessionId}.jsonl`);
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  function assistantLine(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }, model: string): object {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        model,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          api_request_count: 1,
        },
      },
      sessionId: 'test',
      timestamp: new Date(0).toISOString(),
    };
  }

  it('Ark Responses+chain（input_includes_cache）：按 (input-cache_read)+output 累加，首 leg 无 cache 时锚定', async () => {
    // 复刻生产 session 6bb32f27 的 6 leg 序列（glm-5.2 走 input_includes_cache）：
    //   in=10421 cache=    0 out= 35 → 锚定 10456
    //   in= 6816 cache= 6656 out= 42 → +160+42 → 10658
    //   in= 6929 cache= 6784 out= 29 → +145+29 → 10832
    //   in= 7029 cache= 6912 out= 32 → +117+32 → 10981
    //   in= 7132 cache= 6976 out= 36 → +156+36 → 11173
    //   in= 7243 cache= 7104 out= 86 → +139+86 → 11398
    const path = await writeTranscript('ark-chain', [
      assistantLine({ input_tokens: 10421, output_tokens: 35, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 6816, output_tokens: 42, cache_read_input_tokens: 6656 }, 'glm-5.2'),
      assistantLine({ input_tokens: 6929, output_tokens: 29, cache_read_input_tokens: 6784 }, 'glm-5.2'),
      assistantLine({ input_tokens: 7029, output_tokens: 32, cache_read_input_tokens: 6912 }, 'glm-5.2'),
      assistantLine({ input_tokens: 7132, output_tokens: 36, cache_read_input_tokens: 6976 }, 'glm-5.2'),
      assistantLine({ input_tokens: 7243, output_tokens: 86, cache_read_input_tokens: 7104 }, 'glm-5.2'),
    ]);

    const usage = await getTokenUsage(path);

    // 老口径会返回 last leg input+output = 7243+86 = 7329（低估 4k）；
    // 强化 B 逐 leg 累加得 11398（约当 chain 累计历史）
    expect(usage?.contextTokens).toBe(11398);
    // 累计口径不变（sanity check）
    expect(usage?.totalInputTokens).toBe(45570);
    expect(usage?.totalOutputTokens).toBe(260);
    expect(usage?.totalCacheReadTokens).toBe(34432);
  });

  it('input_includes_cache：中途 cache miss（如 /compact 清链后）自动重锚', async () => {
    // 首 3 leg 正常累加，第 4 leg cache_read=0 触发重锚（相当于清了 chain）
    //   in=1000 cache=   0 out=100 → 锚 1100
    //   in= 200 cache= 800 out= 20 → +0+20 = 1120 ??? 等等 200<800 delta=Math.max(0, -600)=0
    //     其实真实 cache_read 不会大于 input_tokens，改成 in=1200 cache=800 更真实
    // 重来：
    //   in=1000 cache=   0 out=100 → 锚 1100
    //   in=1200 cache= 800 out= 20 → +(1200-800)+20 = +420 = 1520
    //   in=1500 cache=1100 out= 30 → +400+30 = 1950
    //   in= 700 cache=   0 out= 40 → 锚 740（compact 清链重锚）
    //   in= 800 cache= 700 out= 50 → +100+50 = 890
    const path = await writeTranscript('cache-miss', [
      assistantLine({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 1200, output_tokens: 20, cache_read_input_tokens: 800 }, 'glm-5.2'),
      assistantLine({ input_tokens: 1500, output_tokens: 30, cache_read_input_tokens: 1100 }, 'glm-5.2'),
      assistantLine({ input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 800, output_tokens: 50, cache_read_input_tokens: 700 }, 'glm-5.2'),
    ]);

    const usage = await getTokenUsage(path);

    expect(usage?.contextTokens).toBe(890);
  });

  it('input_includes_cache：孤立单 leg（cache_read>0）锚定到 input+output，不低估到 delta', async () => {
    // 只有一条 assistant usage，且 cache_read 已 > 0（说明是从更早 chain 接续过来）。
    // 无法追溯之前 leg 序列，此时 input_tokens 已经包含被缓存的历史近似，
    // 直接锚定到 input+output 作为累计上下文估算。
    //   in=4397 cache=4288 out=38 → 4397+38 = 4435
    const path = await writeTranscript('single-leg-warm-cache', [
      assistantLine({ input_tokens: 4397, output_tokens: 38, cache_read_input_tokens: 4288 }, 'glm-5.2'),
    ]);
    const usage = await getTokenUsage(path);
    expect(usage?.contextTokens).toBe(4435);
  });

  it('input_includes_cache：全为 0 的合成/错误行不推进累加', async () => {
    const path = await writeTranscript('zero-usage', [
      assistantLine({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 1100, output_tokens: 30, cache_read_input_tokens: 900 }, 'glm-5.2'),
    ]);

    const usage = await getTokenUsage(path);
    // 首 leg 锚定 1050；中间全 0 跳过；末 leg 累加 (1100-900)+30 = 230 → 1280
    expect(usage?.contextTokens).toBe(1280);
  });

  it('cache_tokens_separate（Anthropic 原生）：沿用最后一 leg turnTotal 老口径', async () => {
    // claude-* 走 cache_tokens_separate：turnTotal = input + output + cache_read + cache_creation
    //   末 leg: 100 + 50 + 800 + 200 = 1150
    const path = await writeTranscript('anthropic', [
      assistantLine({
        input_tokens: 500,
        output_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 400,
      }, 'claude-opus-4-7'),
      assistantLine({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      }, 'claude-opus-4-7'),
    ]);

    const usage = await getTokenUsage(path);
    // Anthropic 全量口径不改：last leg total = 100+50+800+200 = 1150
    expect(usage?.contextTokens).toBe(1150);
  });

  it('累计 mainTotalTokens 口径不受强化 B 影响', async () => {
    const path = await writeTranscript('cumulative', [
      assistantLine({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 }, 'glm-5.2'),
      assistantLine({ input_tokens: 1200, output_tokens: 20, cache_read_input_tokens: 800 }, 'glm-5.2'),
    ]);

    const usage = await getTokenUsage(path);
    // input_includes_cache 的 turnTotal = input + output（缓存记在 input 里）：
    //   leg1: 1000+100 = 1100
    //   leg2: 1200+20  = 1220
    //   累计 = 2320
    expect(usage?.totalTokens).toBe(2320);
    expect(usage?.totalInputTokens).toBe(2200);
    expect(usage?.totalOutputTokens).toBe(120);
    expect(usage?.totalCacheReadTokens).toBe(800);
  });
});

/**
 * 生成一段 UUID 样式字符串（避免测试并发/历史残留互相污染）。
 * 不用 crypto.randomUUID 是因为想更松散（测试用途，不需要 v4 合规）。
 */
function randomUuidLikeString(): string {
  const chars = 'abcdef0123456789';
  const rand = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${rand(8)}-${rand(4)}-${rand(4)}-${rand(4)}-${rand(12)}`;
}

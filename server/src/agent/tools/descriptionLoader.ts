/**
 * 工具 description 同步加载器。
 *
 * 设计目标：把 ToolDescriptor.description 文本抽到 server/src/agent/descriptions/{id}.md，
 * 启动时 hydrate 进 descriptor，其余字段（schema/risk/approvalMode/auditCategory）保持
 * TS 强类型不动。详见 plan：/Users/admin/.claude/plans/squishy-twirling-pebble.md
 *
 * 约束：
 *  - **同步**：descriptor 是模块顶层 `export const`，必须在 import 求值时拿到 string。
 *  - **fail-fast**：md 缺失或为空直接 throw，启动阶段崩 = CI/部署阻断，避免上线后 LLM
 *    拿到空 description 的灰色失败。
 *  - **路径稳定**：用 `import.meta.url` 相对解析，宿主 / Docker / vitest 三处行为一致。
 *  - **归一化**：md 文件可以多行自然段落写（便于阅读编辑），loader 用
 *    `split('\n') → map(trim) → filter(非空) → join(' ')` 还原成单行字符串，与
 *    原 TS 多行 `+` 拼接的字面量字符级等价。当前 16 个工具的 description 都是单段
 *    无换行，归一化方案安全。未来若需保留 markdown 列表/代码块结构，可扩展 raw 模式。
 *
 * 冷启动开销：16 次 readFileSync ≈ 1ms，Map 缓存只读一次，可忽略。
 *
 * 参考范式：server/src/runtime/promptRenderer.ts loadPrompt（也是 readFileSync + Map）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// loader 在 server/src/agent/tools/，descriptions 在 server/src/agent/descriptions/
const DESCRIPTIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'descriptions',
);

const cache = new Map<string, string>();

/**
 * 同步加载并归一化工具 description。
 *
 * @param toolId 工具 id（与 descriptor.id 一致，PascalCase 或 snake_case 原样）
 * @returns 归一化后的单行 description 字符串
 * @throws md 文件不存在 / 读取失败 / 内容为空
 */
export function loadToolDescription(toolId: string): string {
  const hit = cache.get(toolId);
  if (hit !== undefined) return hit;

  const path = join(DESCRIPTIONS_DIR, `${toolId}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // structured log：模块顶层求值阶段 pino 还没初始化，用裸 console.error 输出
    // JSON 形式，方便容器日志聚合（Datadog / CloudWatch / Loki）按 reason 字段告警。
    // 写一行就够 —— 抛错本身有完整 stack。
    console.error(
      JSON.stringify({
        level: 'fatal',
        stage: 'bootstrap',
        reason: 'tool_description_missing',
        toolId,
        expectedPath: path,
        hint: 'check .dockerignore / Dockerfile COPY chain, and server/src/agent/descriptions/',
      }),
    );
    throw new Error(
      `loadToolDescription: description file not found for "${toolId}" `
        + `(expected at ${path}). ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 归一化：行 trim → 丢空行 → 单空格 join
  const normalized = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');

  if (normalized.length === 0) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        stage: 'bootstrap',
        reason: 'tool_description_empty',
        toolId,
        expectedPath: path,
      }),
    );
    throw new Error(
      `loadToolDescription: description for "${toolId}" is empty (${path}).`,
    );
  }

  cache.set(toolId, normalized);
  return normalized;
}

/**
 * 清空进程内缓存。仅用于测试，生产代码不应调用。
 */
export function clearToolDescriptionCache(): void {
  cache.clear();
}

/**
 * 暴露 descriptions 目录绝对路径，便于单测断言路径推导。
 */
export const DESCRIPTIONS_DIR_PATH = DESCRIPTIONS_DIR;

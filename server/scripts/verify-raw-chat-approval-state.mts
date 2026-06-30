/**
 * Verify raw OpenAI Chat approval persistence:
 * model tool_call -> persist pending state -> approve -> ToolRuntime.invoke -> continue.
 *
 * Run:
 *   pnpm -C /Users/admin/code/product/agent-saas exec tsx server/scripts/verify-raw-chat-approval-state.mts
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import OpenAI from 'openai';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  LocalWorkspaceProvider,
  PlatformToolRuntime,
  type ToolCallContext,
  type ToolDescriptor,
} from '../src/agent/toolRuntime.js';
import type { ChannelContext } from '../src/types/index.js';

type Config = {
  models?: {
    groups?: Array<{
      id?: string;
      apiKey?: string;
      baseUrl?: string;
      models?: Array<{ id?: string; value?: string }>;
    }>;
  };
  agent?: { cwd?: string };
};

type PendingState = {
  runId: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  pendingCall: {
    id: string;
    name: string;
    arguments: string;
  };
};

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const TEST_DAY = '20260606';
const RUN_ID = `rawapproval-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function loadConfig(): Promise<Config> {
  return parseJsonc(await readFile(CONFIG_PATH, 'utf-8')) as Config;
}

function resolveModel(config: Config): { apiKey: string; baseURL: string; model: string; workspaceRoot: string } {
  const group = config.models?.groups?.find((g) => g.id === 'openai-agents') ?? config.models?.groups?.[0];
  const model = group?.models?.[0]?.value;
  if (!group?.apiKey) throw new Error('config.models.groups[openai-agents].apiKey missing');
  if (!group?.baseUrl) throw new Error('config.models.groups[openai-agents].baseUrl missing');
  if (!model) throw new Error('config.models.groups[openai-agents].models[0].value missing');
  return {
    apiKey: group.apiKey,
    baseURL: group.baseUrl,
    model,
    workspaceRoot: resolve(config.agent?.cwd ?? '/Users/admin/workspace-openai-runtime', 'admin'),
  };
}

function makeContext(): ChannelContext {
  return {
    channel: 'web',
    timezone: 'Asia/Shanghai',
    user: { id: 'admin', username: 'admin', role: 'admin', realName: '曾磊' },
  };
}

function zodObjectToJsonSchema(descriptor: ToolDescriptor): Record<string, unknown> {
  const schema = descriptor.schema.toJSONSchema() as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function toChatTools(descriptors: ToolDescriptor[]) {
  return descriptors.map((descriptor) => ({
    type: 'function' as const,
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: zodObjectToJsonSchema(descriptor),
    },
  }));
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const resolved = resolveModel(config);
  const targetRel = `assets/${TEST_DAY}/${RUN_ID}.txt`;
  const targetPath = join(resolved.workspaceRoot, targetRel);
  const statePath = join(resolved.workspaceRoot, 'assets', TEST_DAY, `${RUN_ID}.raw-state.json`);
  const token = `RAW_APPROVAL_OK_${RUN_ID}`;

  await mkdir(join(resolved.workspaceRoot, 'assets', TEST_DAY), { recursive: true });
  await rm(targetPath, { force: true }).catch(() => {});
  await rm(statePath, { force: true }).catch(() => {});

  const context = makeContext();
  const workspace = new LocalWorkspaceProvider().resolve(context, { cwd: resolved.workspaceRoot, sessionId: RUN_ID });
  const toolRuntime = new PlatformToolRuntime();
  const toolContext: ToolCallContext = { channelContext: context, workspace };
  const descriptors = toolRuntime.list(toolContext).filter((descriptor) => descriptor.name === 'Write');
  const writeDescriptor = descriptors[0];
  if (!writeDescriptor) throw new Error('Write descriptor missing');

  const client = new OpenAI({ apiKey: resolved.apiKey, baseURL: resolved.baseURL });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: '你是工具审批测试助手。用户要求写文件时必须调用 Write 工具。',
    },
    {
      role: 'user',
      content: `请调用 Write，把 path 写成 ${targetRel}，content 精确写成 ${token}。工具返回后告诉我完成。`,
    },
  ];

  console.log(`model=${resolved.model}`);
  console.log(`baseURL=${resolved.baseURL}`);
  console.log(`target=${targetPath}`);
  console.log('[step 1] raw chat until tool call, but do not execute before approval ...');

  const first = await client.chat.completions.create({
    model: resolved.model,
    messages,
    tools: toChatTools(descriptors),
    tool_choice: 'auto',
    parallel_tool_calls: false,
  } as any);
  const assistant = first.choices[0]?.message as any;
  const pending = assistant?.tool_calls?.[0];
  if (!pending?.id || !pending.function?.name) {
    throw new Error(`no pending tool call; assistant=${JSON.stringify(assistant)}`);
  }
  messages.push({
    role: 'assistant',
    content: assistant.content ?? null,
    tool_calls: assistant.tool_calls,
  } as any);
  const state: PendingState = {
    runId: RUN_ID,
    messages,
    pendingCall: {
      id: String(pending.id),
      name: String(pending.function.name),
      arguments: String(pending.function.arguments ?? '{}'),
    },
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(`pendingTool=${state.pendingCall.name}`);
  console.log(`serializedStateBytes=${(await readFile(statePath, 'utf-8')).length}`);
  if (existsSync(targetPath)) {
    throw new Error('target file exists before approval; raw approval state executed too early');
  }

  console.log('[step 2] rehydrate state, approve by invoking ToolRuntime, continue model ...');
  const rehydrated = JSON.parse(await readFile(statePath, 'utf-8')) as PendingState;
  const parsedInput = JSON.parse(rehydrated.pendingCall.arguments) as unknown;
  const result = await toolRuntime.invoke(
    { toolId: writeDescriptor.id, input: parsedInput },
    toolContext,
  );
  rehydrated.messages.push({
    role: 'tool',
    tool_call_id: rehydrated.pendingCall.id,
    content: result.content,
  });

  const second = await client.chat.completions.create({
    model: resolved.model,
    messages: rehydrated.messages,
    tools: toChatTools(descriptors),
    tool_choice: 'auto',
    parallel_tool_calls: false,
  } as any);
  const finalText = second.choices[0]?.message?.content ?? '';
  console.log(`finalOutput=${String(finalText).replace(/\s+/g, ' ').slice(0, 300)}`);

  if (!existsSync(targetPath)) {
    throw new Error('target file was not created after raw approval + ToolRuntime invoke');
  }
  const written = await readFile(targetPath, 'utf-8');
  if (written !== token) {
    throw new Error(`target content mismatch: expected=${token} actual=${written}`);
  }
  console.log('[PASS] Raw Chat pending approval state serialized, rehydrated, approved, executed, and continued.');
}

await main();

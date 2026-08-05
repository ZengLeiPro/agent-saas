/**
 * 内置 brain-only 工具集：TodoWrite / AskUserQuestion。
 *
 * Workspace 文件工具（Edit / CreateArtifact）已经迁入 workspace hand
 * 契约，由 WorkspaceToolProvider 统一路由到 server-local / server-container /
 * server-remote / client，避免 brain 进程绕过 hand 直接读写 workspace.root。
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AskUserQuestion } from '../types/index.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

export {
  artifactCreateToolDescriptor,
  editToolDescriptor,
} from './workspaceHandTools.js';

export interface BuiltinToolsConfig {
  /** Legacy no-op: Edit is now a workspace hand tool. */
  enableEdit?: boolean;
  enableTodoWrite?: boolean;
  enableAskUserQuestion?: boolean;
  /** Legacy no-op: CreateArtifact is now a workspace hand tool. */
  enableCreateArtifact?: boolean;
  /** Legacy no-op: CreateArtifact is wired through PlatformToolRuntime. */
  artifactService?: unknown;
  /** 共享 TodoWrite store（不传则使用模块级单例）。 */
  todoStore?: SessionTodoStore;
}

const TODO_LRU_CAPACITY = 1024;

type TodoItem = {
  id: string;
  kind: 'business';
  content: string;
  status: 'pending' | 'in_progress' | 'waiting' | 'blocked' | 'completed' | 'failed';
  activeForm?: string;
  outcome?: {
    text: string;
    tone?: 'ok' | 'warn' | 'fail';
    stat?: Array<{ label: string; value: string }>;
  };
  detail?: unknown[];
  display?: unknown[];
  evidenceRefs?: string[];
};

type TodoWriteInput = {
  todos: TodoItem[];
};

type AskUserQuestionInput = {
  questions: AskUserQuestion[];
};

const todoTextSchema = z.string().min(1).max(500);
const todoToneSchema = z.enum(['neutral', 'info', 'success', 'warn', 'danger', 'muted']);
const todoDetailLineSchema = z.union([
  todoTextSchema,
  z.object({ tree: z.enum(['├', '└']), k: todoTextSchema, v: z.string().max(500) }),
  z.object({ k: todoTextSchema, v: z.string().max(500) }),
  z.object({ no: z.number().int(), text: todoTextSchema }),
  z.object({ indent: z.number().int().min(0).max(6), text: todoTextSchema }),
  z.object({ section: todoTextSchema }),
  z.object({ warn: todoTextSchema }),
  z.object({ insight: todoTextSchema, label: todoTextSchema.optional() }),
  z.object({ risk: z.enum(['high', 'medium']), text: todoTextSchema, action: todoTextSchema.optional() }),
  z.object({ verdict: z.enum(['pass', 'fail', 'warn', 'pending']), text: todoTextSchema, note: todoTextSchema.optional() }),
  z.object({ quote: todoTextSchema, source: todoTextSchema.optional() }),
  z.object({ original: todoTextSchema, translation: todoTextSchema.optional() }),
  z.object({
    fields: z.array(z.object({ k: todoTextSchema, v: z.string().max(500) })).min(1).max(12),
  }),
]);

const todoRecordItemSchema = z.object({
  label: todoTextSchema,
  value: z.string().max(500).optional(),
  tag: z.object({ tone: todoToneSchema, text: todoTextSchema }).optional(),
  note: todoTextSchema.optional(),
  tone: todoToneSchema.optional(),
  detail: z.array(todoDetailLineSchema).max(60).optional(),
  mono: z.boolean().optional(),
});

// TodoWrite 只产出无交互展示块。需要用户确认时继续使用 AskUserQuestion / permission_request，
// 避免模型通过 Todo 入参伪造一个看似可点击、实际上没有回写通道的审批卡。
const todoDisplayBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('callout'),
    tone: todoToneSchema,
    title: todoTextSchema.optional(),
    body: z.array(todoTextSchema).min(1).max(20),
    detail: z.array(todoDetailLineSchema).max(60).optional(),
    collapsible: z.boolean().optional(),
    defaultOpen: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('records'),
    layout: z.enum(['rows', 'grid', 'checklist']),
    title: z.string().min(1).max(80).describe('表格标题，必填。使用简短业务动作或结果名称，如“核对工作树状态”“已创建提交”。'),
    items: z.array(todoRecordItemSchema).min(1).max(100),
    footer: todoTextSchema.optional(),
  }),
]);

export const todoWriteToolDescriptor: ToolDescriptor<TodoWriteInput> = {
  id: 'TodoWrite',
  name: 'TodoWrite',
  displayName: 'Todo Write',
  description: loadToolDescription('TodoWrite'),
  descriptionInvariants: ['每个 `records.title` 都必填'],
  schema: z.object({
    todos: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          kind: z.literal('business'),
          content: todoTextSchema,
          status: z.enum(['pending', 'in_progress', 'waiting', 'blocked', 'completed', 'failed']),
          activeForm: todoTextSchema.optional(),
          // 折叠视图里步骤只剩标题一行，outcome 是唯一的信息位；
          // 完成但有例外必须 tone:'warn'，不允许干净「已完成」掩盖例外。
          outcome: z
            .object({
              text: z.string().min(1).max(120),
              tone: z.enum(['ok', 'warn', 'fail']).optional(),
              stat: z
                .array(z.object({ label: z.string().min(1).max(20), value: z.string().min(1).max(40) }))
                .max(6)
                .optional(),
            })
            .optional(),
          detail: z.array(todoDetailLineSchema).max(60).optional(),
          display: z.array(todoDisplayBlockSchema).max(12).optional(),
          evidenceRefs: z.array(z.string().min(1).max(200)).max(20).optional(),
        }),
      )
      .max(50),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'meta.todo',
  category: 'meta',
  label: '管理 TODO',
};

export const askUserQuestionToolDescriptor: ToolDescriptor<AskUserQuestionInput> = {
  id: 'AskUserQuestion',
  name: 'AskUserQuestion',
  displayName: 'Ask User Question',
  description: loadToolDescription('AskUserQuestion'),
  schema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().min(1),
          header: z.string().min(1).max(12).describe('显示为小标签（chip）的简短文字，最多 12 字符。'),
          options: z
            .array(z.object({ label: z.string().min(1), description: z.string() }))
            .min(2)
            .max(4),
          multiSelect: z.boolean().optional().default(false),
        }),
      )
      .min(1)
      .max(4),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'meta.ask_user',
  category: 'meta',
  label: '向用户提问',
  // 与 schema 的 multiSelect 默认值绑定：描述丢了这句，模型会以为必须显式传 false。
  descriptionInvariants: ['运行时默认为 false'],
};

export interface SessionTodoStore {
  get(sessionId: string): TodoItem[];
  set(sessionId: string, items: TodoItem[]): void;
}

class LruTodoStore implements SessionTodoStore {
  private readonly map = new Map<string, TodoItem[]>();

  constructor(private readonly capacity: number = TODO_LRU_CAPACITY) {}

  get(sessionId: string): TodoItem[] {
    const v = this.map.get(sessionId);
    if (!v) return [];
    this.map.delete(sessionId);
    this.map.set(sessionId, v);
    return v;
  }

  set(sessionId: string, items: TodoItem[]): void {
    if (this.map.has(sessionId)) this.map.delete(sessionId);
    this.map.set(sessionId, items);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (!oldest) break;
      this.map.delete(oldest);
    }
  }
}

const sharedTodoStore: SessionTodoStore = new LruTodoStore();

export class BuiltinToolProvider implements ToolProvider {
  private readonly descriptors: ToolDescriptor[];
  private readonly todoStore: SessionTodoStore;

  constructor(private readonly config: BuiltinToolsConfig = {}) {
    const enabled: ToolDescriptor[] = [];
    if (config.enableTodoWrite !== false) enabled.push(todoWriteToolDescriptor);
    if (config.enableAskUserQuestion !== false) enabled.push(askUserQuestionToolDescriptor);
    this.descriptors = enabled;
    this.todoStore = config.todoStore ?? sharedTodoStore;
  }

  list(): ToolDescriptor[] {
    return this.descriptors;
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    switch (call.toolId) {
      case todoWriteToolDescriptor.id:
        return this.runTodoWrite(
          todoWriteToolDescriptor.schema.parse(call.input) as TodoWriteInput,
          context,
        );
      case askUserQuestionToolDescriptor.id:
        return this.runAskUserQuestion(
          askUserQuestionToolDescriptor.schema.parse(call.input) as AskUserQuestionInput,
          context,
        );
      default:
        return undefined;
    }
  }

  private async runTodoWrite(input: TodoWriteInput, context: ToolCallContext): Promise<ToolResult> {
    const sessionId = context.workspace.sessionId;
    if (!sessionId) {
      throw new Error('TodoWrite: workspace.sessionId required (no fallback to avoid cross-session collision).');
    }
    this.todoStore.set(sessionId, input.todos);
    const summary = input.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n');
    return {
      content: `TODO list updated (${input.todos.length} items):\n${summary}`,
    };
  }

  private async runAskUserQuestion(
    input: AskUserQuestionInput,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    if (!context.hooks?.onInteraction) {
      throw new Error(
        'AskUserQuestion: HITL hook not registered on this channel; '
          + 'fall back to asking the user directly in your assistant reply.',
      );
    }
    const interactionId = randomUUID();
    const response = await context.hooks.onInteraction({
      type: 'ask_user',
      interactionId,
      sessionId: context.sessionId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      invocationId: context.invocationId,
      questions: input.questions,
      toolId: askUserQuestionToolDescriptor.id,
      toolName: askUserQuestionToolDescriptor.name,
      displayName: askUserQuestionToolDescriptor.displayName,
    });
    const answers = response?.answers ?? {};
    return {
      content: JSON.stringify(
        {
          answers,
          message: response?.message,
          schemaNote: 'For questions with multiSelect=true, the answer may be a comma-separated list.',
        },
        null,
        2,
      ),
    };
  }
}

export function createBuiltinTools(config?: BuiltinToolsConfig): BuiltinToolProvider {
  return new BuiltinToolProvider(config);
}

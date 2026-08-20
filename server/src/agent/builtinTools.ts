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
// TodoWrite 顶层 detail 只承载非表格摘要；section 会形成标题分组，必须改用语义 display 块。
// 嵌套 detail 仍允许 section，历史 transcript 则由 Shared/Web 继续兼容。
const todoSummaryDetailLineSchema = z.union([
  todoTextSchema,
  z.object({ no: z.number().int(), text: todoTextSchema }),
  z.object({ indent: z.number().int().min(0).max(6), text: todoTextSchema }),
  z.object({ warn: todoTextSchema }),
  z.object({ insight: todoTextSchema, label: todoTextSchema.optional() }),
  z.object({ risk: z.enum(['high', 'medium']), text: todoTextSchema, action: todoTextSchema.optional() }),
  z.object({ verdict: z.enum(['pass', 'fail', 'warn', 'pending']), text: todoTextSchema, note: todoTextSchema.optional() }),
  z.object({ quote: todoTextSchema, source: todoTextSchema.optional() }),
  z.object({ original: todoTextSchema, translation: todoTextSchema.optional() }),
]);

const todoSummaryDetailSchema = z.array(todoSummaryDetailLineSchema).max(60).superRefine((lines, context) => {
  const verdictCount = lines.filter((line) => typeof line === 'object' && line !== null && 'verdict' in line).length;
  if (verdictCount > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '顶层 detail 最多允许一条 verdict；多项判定必须使用带 title 的 display checklist。',
    });
  }
});

const todoDetailLineSchema = z.union([
  todoSummaryDetailLineSchema,
  z.object({ section: todoTextSchema }),
]);

const todoDisplayTextSchema = z.string().trim().min(1).max(500);
const todoDisplayTitleSchema = z.string().trim().min(1).max(80)
  .describe('分组标题，必填。使用简短业务动作或结果名称，如“核对工作树状态”“已创建提交”。');

const todoListItemSchema = z.object({
  label: todoDisplayTextSchema,
  value: todoDisplayTextSchema.optional(),
  note: todoDisplayTextSchema.optional(),
  detail: z.array(todoDetailLineSchema).max(60).optional(),
}).strict();

const todoFactsItemSchema = z.object({
  label: todoDisplayTextSchema,
  value: todoDisplayTextSchema,
}).strict();

const todoComparisonItemSchema = z.object({
  label: todoDisplayTextSchema,
  baseline: todoDisplayTextSchema,
  current: todoDisplayTextSchema,
  delta: todoDisplayTextSchema,
  status: z.enum(['pass', 'fail', 'warn', 'pending']).optional(),
  note: todoDisplayTextSchema.optional(),
  detail: z.array(todoDetailLineSchema).max(60).optional(),
}).strict();

const todoChecklistItemSchema = z.object({
  label: todoDisplayTextSchema,
  status: z.enum(['pass', 'fail', 'warn', 'pending']),
  value: todoDisplayTextSchema.optional(),
  note: todoDisplayTextSchema.optional(),
  detail: z.array(todoDetailLineSchema).max(60).optional(),
}).strict();

// Agent 只提交业务语义，不选择 callout / records / rows / grid 等视觉实现。
// 历史 transcript 的旧展示协议由 Shared/Web 读取侧兼容，不进入新 Tool schema。
const todoDisplayBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('facts').describe('相互独立的短字段；展示层会在适合时自动排成网格。'),
    title: todoDisplayTitleSchema,
    items: z.array(todoFactsItemSchema).min(1).max(100),
    footer: todoDisplayTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('list').describe('普通清单、命中列表或提交记录。'),
    title: todoDisplayTitleSchema,
    items: z.array(todoListItemSchema).min(1).max(100),
    footer: todoDisplayTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('comparison').describe('预期/实际或变更前后的四列差异对照。'),
    title: todoDisplayTitleSchema,
    items: z.array(todoComparisonItemSchema).min(1).max(100),
    footer: todoDisplayTextSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('checklist').describe('逐项通过、失败、警告或待定的判定清单。'),
    title: todoDisplayTitleSchema,
    items: z.array(todoChecklistItemSchema).min(1).max(100),
    footer: todoDisplayTextSchema.optional(),
  }).strict(),
]);

export const todoWriteToolDescriptor: ToolDescriptor<TodoWriteInput> = {
  id: 'TodoWrite',
  name: 'TodoWrite',
  displayName: 'Todo Write',
  description: loadToolDescription('TodoWrite'),
  descriptionInvariants: [
    '`display`：只接受 `facts`、`list`、`comparison`、`checklist` 四种业务语义',
    '不接受 `callout`、`records` 或 `layout` 等视觉实现字段',
    '顶层 `detail` 不接受 `section`，且最多一条 `verdict`',
    '不接受 `k/v`、树形键值或字段网格',
  ],
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
          detail: todoSummaryDetailSchema.optional(),
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

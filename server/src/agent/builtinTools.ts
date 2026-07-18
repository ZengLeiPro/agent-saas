/**
 * 内置 brain-only 工具集：TodoWrite / AskUserQuestion。
 *
 * Workspace 文件工具（Edit / Glob / Grep / CreateArtifact）已经迁入 workspace hand
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
  globToolDescriptor,
  grepToolDescriptor,
} from './workspaceHandTools.js';

export interface BuiltinToolsConfig {
  /** Legacy no-op: Edit is now a workspace hand tool. */
  enableEdit?: boolean;
  /** Legacy no-op: Glob is now a workspace hand tool. */
  enableGlob?: boolean;
  /** Legacy no-op: Grep is now a workspace hand tool. */
  enableGrep?: boolean;
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
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

type TodoWriteInput = {
  todos: TodoItem[];
};

type AskUserQuestionInput = {
  questions: AskUserQuestion[];
};

export const todoWriteToolDescriptor: ToolDescriptor<TodoWriteInput> = {
  id: 'TodoWrite',
  name: 'TodoWrite',
  displayName: 'Todo Write',
  description: loadToolDescription('TodoWrite'),
  schema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1),
          status: z.enum(['pending', 'in_progress', 'completed']),
          activeForm: z.string().optional(),
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
          header: z.string().min(1).max(12).describe('Short chip label, max 12 chars.'),
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

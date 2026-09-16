import { createHash } from 'node:crypto';
import { z } from 'zod';

import { DatabaseQueryError, type DatabaseQueryExecutor } from '../databaseQuery/index.js';
import type { DatabaseConnectionStore } from '../data/databaseConnections/index.js';
import type { ExternalClientStore } from '../data/externalClients/index.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

const databaseQuerySchema = z.object({
  sql: z
    .string()
    .trim()
    .min(1)
    .max(100_000)
    .describe('单条 PostgreSQL SELECT；表名必须带 schema。'),
  parameters: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .max(100)
    .optional(),
  maxRows: z.number().int().min(1).max(1_000).optional(),
});

export const databaseQueryReadonlyDescriptor: ToolDescriptor = {
  id: 'DatabaseQueryReadonly',
  name: 'DatabaseQueryReadonly',
  displayName: '只读数据库查询',
  description:
    '查询当前外部会话已由服务端绑定的客户只读数据库。仅接受一条 SELECT，表名必须带 schema；不能选择或切换连接，不能执行写入、锁表、文件、网络或管理函数。结果受行数、字节数、超时和敏感字段脱敏限制。',
  schema: databaseQuerySchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'external.database.query',
  category: 'core',
  label: '只读数据库',
};

export interface DatabaseQueryReadonlyToolProviderOptions {
  store: DatabaseConnectionStore;
  externalClients: Pick<ExternalClientStore, 'get'>;
  executor: DatabaseQueryExecutor;
}

function hashSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export class DatabaseQueryReadonlyToolProvider implements ToolProvider {
  constructor(private readonly options: DatabaseQueryReadonlyToolProviderOptions) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    return context?.externalApi?.databaseConnectionId ? [databaseQueryReadonlyDescriptor] : [];
  }

  async invoke(
    call: AuthorizedToolCall,
    context: ToolCallContext,
  ): Promise<ToolResult | undefined> {
    if (call.toolId !== databaseQueryReadonlyDescriptor.id) return undefined;
    const external = context.externalApi;
    const tenantId = context.workspace.tenantId;
    const sessionId = context.sessionId;
    const runId = context.runId;
    if (!external?.databaseConnectionId || !tenantId || !sessionId || !runId) {
      throw new DatabaseQueryError('database_connection_not_found');
    }
    const input = databaseQuerySchema.parse(call.input);
    const started = Date.now();
    const connection = await this.options.store.get(external.databaseConnectionId);
    const client = await this.options.externalClients.get(external.apiClientId);
    const authorized =
      connection?.tenantId === tenantId &&
      client?.tenantId === tenantId &&
      client.status === 'active' &&
      client.allowedConnectionIds.includes(external.databaseConnectionId);
    if (!authorized || !connection) {
      await this.auditFailure(
        {
          connectionId: external.databaseConnectionId,
          tenantId,
          apiClientId: external.apiClientId,
          conversationId: external.conversationId,
          sessionId,
          runId,
          sql: input.sql,
          started,
          code: 'database_connection_not_found',
        },
        false,
      );
      throw new DatabaseQueryError('database_connection_not_found');
    }
    try {
      const result = await this.options.executor.execute({
        connection,
        sql: input.sql,
        ...(input.parameters ? { parameters: input.parameters } : {}),
        ...(input.maxRows ? { maxRows: input.maxRows } : {}),
      });
      await this.options.store.recordQueryAudit({
        connectionId: connection.connectionId,
        tenantId,
        apiClientId: external.apiClientId,
        conversationId: external.conversationId,
        sessionId,
        runId,
        sqlHash: result.sqlHash,
        status: 'completed',
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        resultBytes: result.resultBytes,
        truncated: result.truncated,
      });
      return {
        content: JSON.stringify({
          columns: result.columns,
          rows: result.rows,
          row_count: result.rowCount,
          truncated: result.truncated,
          duration_ms: result.durationMs,
        }),
      };
    } catch (error) {
      const code = error instanceof DatabaseQueryError ? error.code : 'database_query_failed';
      await this.auditFailure(
        {
          connectionId: connection.connectionId,
          tenantId,
          apiClientId: external.apiClientId,
          conversationId: external.conversationId,
          sessionId,
          runId,
          sql: input.sql,
          started,
          code,
        },
        true,
      );
      throw error instanceof DatabaseQueryError
        ? error
        : new DatabaseQueryError('database_query_failed');
    }
  }

  private async auditFailure(
    input: {
      connectionId: string;
      tenantId: string;
      apiClientId: string;
      conversationId: string;
      sessionId: string;
      runId: string;
      sql: string;
      started: number;
      code: string;
    },
    connectionKnown: boolean,
  ): Promise<void> {
    if (!connectionKnown) return;
    await this.options.store
      .recordQueryAudit({
        connectionId: input.connectionId,
        tenantId: input.tenantId,
        apiClientId: input.apiClientId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        runId: input.runId,
        sqlHash: hashSql(input.sql),
        status: input.code === 'database_query_rejected' ? 'rejected' : 'failed',
        durationMs: Date.now() - input.started,
        rowCount: 0,
        resultBytes: 0,
        truncated: false,
        errorCode: input.code,
      })
      .catch(() => undefined);
  }
}

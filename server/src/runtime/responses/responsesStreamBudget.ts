/** 工程保护初值，不是 token 上限或正常请求分布的统计结论。 */
export const RESPONSES_STREAM_LIMITS = {
  callBytes: 2 * 1024 * 1024,
  argumentBytes: 8 * 1024 * 1024,
  wireBytes: 32 * 1024 * 1024,
  deadlineMs: 15 * 60_000,
  idleMs: 5 * 60_000,
} as const;

export type ResponsesStreamLimits = { [K in keyof typeof RESPONSES_STREAM_LIMITS]: number };

export class ResponsesStreamGuardError extends Error {
  readonly outcome = 'stream_error' as const;
  constructor(
    readonly code: string,
    detail: string,
    readonly recoverySafe = true,
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'ResponsesStreamGuardError';
  }
}

/** 只允许本地 function 与纯工具目录检索自动重放；未知 hosted 执行能力保守失败。 */
export function isLocalResponsesRequest(body: Record<string, unknown>): boolean {
  const safe = (tool: any): boolean =>
    tool?.type === 'function' ||
    tool?.type === 'tool_search' ||
    (tool?.type === 'namespace' && Array.isArray(tool.tools) && tool.tools.every(safe));
  return !body.tools || (Array.isArray(body.tools) && body.tools.every(safe));
}

export function isResponsesSemanticProgress(event: Record<string, any>): boolean {
  const type = String(event.type ?? '');
  return (
    (type.endsWith('.delta') && typeof event.delta === 'string' && event.delta.length > 0) ||
    (type === 'response.output_item.added' && typeof event.item?.type === 'string') ||
    type === 'response.output_item.done'
  );
}

export class ResponsesStreamBudget {
  wireBytes = 0;
  argumentBytes = 0;
  argumentDeltaCount = 0;
  lastProgressAt = Date.now();
  terminal = false;
  recoverySafe: boolean;
  private readonly calls = new Map<number, { bytes: number; high: number; name?: string }>();
  private readonly indices = new Map<string, number>();

  constructor(
    body: Record<string, unknown>,
    readonly limits: ResponsesStreamLimits = RESPONSES_STREAM_LIMITS,
  ) {
    this.recoverySafe = isLocalResponsesRequest(body);
  }

  error(code: string, index?: number): ResponsesStreamGuardError {
    const call = index === undefined ? undefined : this.calls.get(index);
    return new ResponsesStreamGuardError(
      code,
      JSON.stringify({
        wireBytes: this.wireBytes,
        argumentBytes: this.argumentBytes,
        argumentDeltaCount: this.argumentDeltaCount,
        outputIndex: index,
        callBytes: call?.bytes,
        tool: call?.name,
        lastProgressAt: this.lastProgressAt,
        limits: this.limits,
      }),
      this.recoverySafe,
    );
  }

  observeBytes(bytes: number): void {
    this.wireBytes += bytes;
    if (this.wireBytes > this.limits.wireBytes) throw this.error('MODEL_STREAM_WIRE_LIMIT');
  }

  observe(event: Record<string, any>): void {
    const type = String(event.type ?? '');
    // 先检查整个快照的副作用类型，再做可能抛错的预算检查，不能受 item 顺序影响。
    const items = [
      ...(event.item ? [event.item] : []),
      ...(Array.isArray(event.response?.output) ? event.response.output : []),
    ];
    if (
      items.some(
        (item) =>
          ![
            'function_call',
            'message',
            'reasoning',
            'tool_search_call',
            'tool_search_output',
          ].includes(item?.type),
      )
    )
      this.recoverySafe = false;
    if (isResponsesSemanticProgress(event)) this.lastProgressAt = Date.now();
    const item = event.item;
    let index = typeof event.output_index === 'number' ? event.output_index : undefined;
    if (index !== undefined && typeof item?.id === 'string') this.indices.set(item.id, index);
    if (index === undefined && typeof event.item_id === 'string')
      index = this.indices.get(event.item_id);
    index ??= 0;
    if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      this.argumentDeltaCount += 1;
      this.arguments(index, event.delta, true);
    } else if (
      type === 'response.function_call_arguments.done' &&
      typeof event.arguments === 'string'
    ) {
      this.arguments(index, event.arguments, false);
    }
    if (item) this.item(item, index);
    if (
      [
        'response.completed',
        'response.done',
        'response.failed',
        'response.incomplete',
        'response.cancelled',
        'response.error',
        'error',
      ].includes(type)
    ) {
      if (Array.isArray(event.response?.output)) {
        event.response.output.forEach((value: any, fallback: number) => {
          this.item(value, this.indices.get(value?.id) ?? fallback);
        });
      }
      this.terminal = true;
    }
  }

  snapshot() {
    return {
      wireBytes: this.wireBytes,
      argumentBytes: this.argumentBytes,
      argumentDeltaCount: this.argumentDeltaCount,
      lastProgressAt: this.lastProgressAt,
      calls: [...this.calls]
        .sort((a, b) => b[1].high - a[1].high)
        .slice(0, 8)
        .map(([outputIndex, call]) => ({ outputIndex, ...call })),
    };
  }

  private item(item: Record<string, any>, index: number): void {
    if (item?.type !== 'function_call') return;
    if (typeof item.id === 'string') this.indices.set(item.id, index);
    if (typeof item.arguments === 'string') this.arguments(index, item.arguments, false, item.name);
  }

  private arguments(index: number, value: string, delta: boolean, name?: unknown): void {
    const call = this.calls.get(index) ?? { bytes: 0, high: 0 };
    const bytes = Buffer.byteLength(value, 'utf8');
    call.bytes = delta ? call.bytes + bytes : bytes;
    if (typeof name === 'string') call.name = name.replace(/[^\w.:-]/g, '').slice(0, 100);
    this.argumentBytes += Math.max(0, call.bytes - call.high);
    call.high = Math.max(call.high, call.bytes);
    this.calls.set(index, call);
    if (call.bytes > this.limits.callBytes) throw this.error('MODEL_TOOL_ARGUMENT_LIMIT', index);
    if (this.argumentBytes > this.limits.argumentBytes)
      throw this.error('MODEL_TOOL_ARGUMENT_TOTAL_LIMIT', index);
  }
}

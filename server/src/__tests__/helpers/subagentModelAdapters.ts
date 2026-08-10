import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../../runtime/types.js';

/** 一次成功即收束的模型：可选记录第一轮 request（工具集断言用）。 */
export class TextOnlyAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];
  contexts: RunContext[] = [];

  constructor(private readonly text = '子任务完成：结论 A。') {}

  async *stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.contexts.push(context);
    yield { type: 'text_delta', content: this.text };
    yield {
      type: 'completed',
      content: this.text,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

/** 悬挂直到 signal abort（超时 / 级联取消路径）。 */
export class HangingAdapter implements ModelAdapter {
  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('model stream aborted'));
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener('abort', abort, { once: true });
    });
    throw new Error('unreachable');
  }
}

/** 首轮即抛（上游 API 5xx 形态）。 */
export class FailingAdapter implements ModelAdapter {
  // eslint-disable-next-line require-yield
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    throw new Error('upstream 500: model unavailable');
  }
}

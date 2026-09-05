import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ResponsesStreamBudget,
  RESPONSES_STREAM_LIMITS,
} from '../runtime/responses/responsesStreamBudget.js';
import { executeBoundedResponses } from '../runtime/responses/boundedResponsesTransport.js';
import type {
  ResponsesTransport,
  ResponsesTransportExecuteInput,
} from '../runtime/responses/responsesTransport.js';

const limits = {
  ...RESPONSES_STREAM_LIMITS,
  callBytes: 12,
  argumentBytes: 18,
  wireBytes: 200,
  deadlineMs: 100,
  idleMs: 40,
};
const call = (arguments_: string, id = 'fc1') => ({
  type: 'function_call',
  id,
  name: 'Shell',
  arguments: arguments_,
});
const delta = (value: string, index = 0) => ({
  type: 'response.function_call_arguments.delta',
  output_index: index,
  delta: value,
});
const input: ResponsesTransportExecuteInput = {
  serializedBody: '{}',
  clientRequestId: 'test',
  context: {
    runId: 'r',
    sessionId: 's',
    model: 'm',
    cwd: '/tmp',
    channelContext: { channel: 'web' },
  },
};
function transport(execute: ResponsesTransport['execute']): ResponsesTransport {
  return {
    id: 'openai_compatible',
    execute,
    computePromptCacheKey: () => undefined,
    capabilities: {
      responseState: 'stateless',
      terminalOutput: 'canonical',
      usageLookup: false,
      responseDelete: false,
      encryptedReasoning: false,
      omitToolConfigurationWhenEmpty: true,
      parallelToolCalls: true,
      maxOutputTokens: true,
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Responses 参数预算', () => {
  it('按 UTF-8 计量，delta、done、terminal 同一 call 不重复收费', () => {
    const budget = new ResponsesStreamBudget({}, limits);
    budget.observe({ type: 'response.output_item.added', output_index: 3, item: call('') });
    budget.observe(delta('中文🙂', 3));
    budget.observe({ type: 'response.output_item.done', output_index: 3, item: call('中文🙂') });
    budget.observe({ type: 'response.completed', response: { output: [call('中文🙂')] } });
    expect(budget.argumentBytes).toBe(10);
    expect(budget.argumentDeltaCount).toBe(1);
  });
  it.each([
    'response.output_item.added',
    'response.output_item.done',
    'response.function_call_arguments.done',
    'response.completed',
  ])('%s 的完整快照不能绕过预算', (type) => {
    const budget = new ResponsesStreamBudget({}, limits);
    expect(() =>
      budget.observe({
        type,
        output_index: 0,
        item: call('x'.repeat(13)),
        arguments: 'x'.repeat(13),
        response: { output: [call('x'.repeat(13))] },
      }),
    ).toThrow('MODEL_TOOL_ARGUMENT_LIMIT');
  });
  it('多 call 高水位累计有界，缩小快照不退还预算', () => {
    const budget = new ResponsesStreamBudget({}, limits);
    budget.observe(delta('x'.repeat(12)));
    budget.observe({ type: 'response.output_item.done', output_index: 0, item: call('') });
    expect(() => budget.observe(delta('x'.repeat(7), 1))).toThrow(
      'MODEL_TOOL_ARGUMENT_TOTAL_LIMIT',
    );
  });
  it('不按分帧次数误伤正常 256KiB 以上参数', () => {
    const budget = new ResponsesStreamBudget({});
    for (let i = 0; i < 20_000; i++) budget.observe(delta('x'.repeat(20)));
    expect(budget.argumentBytes).toBe(400_000);
  });
  it('未知 hosted 执行能力或执行事件禁止自动恢复', () => {
    expect(new ResponsesStreamBudget({ tools: [{ type: 'mcp' }] }).recoverySafe).toBe(false);
    const budget = new ResponsesStreamBudget({
      tools: [{ type: 'namespace', tools: [{ type: 'function' }] }],
    });
    budget.observe({ type: 'response.output_item.added', item: { type: 'computer_call' } });
    expect(budget.error('MODEL_STREAM_DEADLINE').recoverySafe).toBe(false);
  });
  it('诊断最多八项且不包含参数正文', () => {
    const budget = new ResponsesStreamBudget({});
    for (let i = 0; i < 20; i++) budget.observe(delta('secret-value', i));
    expect(budget.snapshot().calls).toHaveLength(8);
    expect(JSON.stringify(budget.snapshot())).not.toContain('secret-value');
  });
  it('完整快照先识别所有 hosted 副作用，再因前项超额抛错', () => {
    const budget = new ResponsesStreamBudget({}, limits);
    try {
      budget.observe({
        type: 'response.completed',
        response: { output: [call('x'.repeat(13)), { type: 'mcp_call' }] },
      });
      expect.fail('应该超限');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_TOOL_ARGUMENT_LIMIT', recoverySafe: false });
    }
  });
});

describe('Responses 传输截止与清理', () => {
  it('transport 刚返回与用户停止的微任务竞态仍清理迟到响应', async () => {
    const controller = new AbortController();
    const invalidate = vi.fn();
    const cancel = vi.fn();
    let resolve!: (value: { response: Response; invalidate: () => void }) => void;
    const pending = new Promise<{ response: Response; invalidate: () => void }>((done) => {
      resolve = done;
    });
    void pending.then(() => queueMicrotask(() => controller.abort(new Error('user-stop'))));
    const result = executeBoundedResponses(
      transport(() => pending),
      { ...input, signal: controller.signal },
      limits,
    );
    const check = expect(result).rejects.toThrow('user-stop');
    resolve({ response: new Response(new ReadableStream({ cancel })), invalidate });
    await check;
    expect(invalidate).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('首帧之前也有绝对截止，并 abort 实际 transport', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = executeBoundedResponses(
      transport(async (request) => {
        signal = request.signal;
        return new Promise(() => undefined);
      }),
      input,
      { ...limits, idleMs: 200 },
    );
    const check = expect(pending).rejects.toThrow('MODEL_STREAM_DEADLINE');
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('持续真实分片可续 idle，但不能延长绝对截止', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const result = await executeBoundedResponses(
      transport(async () => ({
        response: new Response(new ReadableStream({ cancel })),
      })),
      input,
      limits,
    );
    const read = expect(result.response.body!.getReader().read()).rejects.toThrow(
      'MODEL_STREAM_DEADLINE',
    );
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30);
      result.guard.observe(delta('a'));
    }
    await vi.advanceTimersByTimeAsync(10);
    await read;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('控制帧和空 delta 不续 idle，cancel 永不结束也不会卡住', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const result = await executeBoundedResponses(
      transport(async () => ({
        response: new Response(new ReadableStream({ cancel })),
      })),
      input,
      limits,
    );
    const read = expect(result.response.body!.getReader().read()).rejects.toThrow(
      'MODEL_STREAM_IDLE_TIMEOUT',
    );
    await vi.advanceTimersByTimeAsync(30);
    result.guard.observe({ type: 'response.in_progress' });
    result.guard.observe(delta(''));
    await vi.advanceTimersByTimeAsync(10);
    await read;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('用户取消优先，不误报内部截止', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = await executeBoundedResponses(
      transport(async () => ({ response: new Response(new ReadableStream()) })),
      { ...input, signal: controller.signal },
      limits,
    );
    const check = expect(result.response.body!.getReader().read()).rejects.toThrow('user-stop');
    controller.abort(new Error('user-stop'));
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('读入累计字节在交给 adapter 之前检查', async () => {
    const result = await executeBoundedResponses(
      transport(async () => ({ response: new Response('x'.repeat(201)) })),
      input,
      limits,
    );
    await expect(result.response.text()).rejects.toThrow('MODEL_STREAM_WIRE_LIMIT');
  });
  it('WS 已收终态后拒绝快照仍能 invalidate 锚点', async () => {
    const invalidate = vi.fn();
    const result = await executeBoundedResponses(
      transport(async () => ({ response: new Response('done'), invalidate })),
      input,
      limits,
    );
    await result.response.text();
    expect(() =>
      result.guard.observe({
        type: 'response.completed',
        response: { output: [call('x'.repeat(13))] },
      }),
    ).toThrow('MODEL_TOOL_ARGUMENT_LIMIT');
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

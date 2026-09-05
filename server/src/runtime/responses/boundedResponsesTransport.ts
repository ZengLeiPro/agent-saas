import type { ResponsesTransport, ResponsesTransportExecuteInput } from './responsesTransport.js';
import {
  RESPONSES_STREAM_LIMITS,
  ResponsesStreamBudget,
  ResponsesStreamGuardError,
  type ResponsesStreamLimits,
} from './responsesStreamBudget.js';

/** 每个真实 attempt 独立截止；取消实际传输，不等待不守约的 cancel promise。 */
export async function executeBoundedResponses(
  transport: ResponsesTransport,
  input: ResponsesTransportExecuteInput,
  limits: ResponsesStreamLimits = RESPONSES_STREAM_LIMITS,
) {
  const budget = new ResponsesStreamBudget(JSON.parse(input.serializedBody), limits);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseBody: ReadableStream<Uint8Array> | null | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let invalidate: (() => void) | undefined;
  let stopped = false;
  let failure: unknown;
  let rejectPending: (error: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectPending = reject;
  });
  // 传输已返回时仍可能触发 timer；保持拒绝有观察者。
  void cancelled.catch(() => undefined);
  const dispose = () => {
    clearTimeout(deadline);
    clearTimeout(idle);
    input.signal?.removeEventListener('abort', onAbort);
  };
  const cancelTransport = (error?: unknown) => {
    invalidate?.();
    if (reader) void reader.cancel(error).catch(() => undefined);
    else void responseBody?.cancel(error).catch(() => undefined);
  };
  const stop = (error: unknown) => {
    if (stopped) return;
    if (error instanceof ResponsesStreamGuardError && !budget.recoverySafe) {
      error = new ResponsesStreamGuardError(error.code, error.message, false);
    }
    stopped = true;
    failure = error;
    dispose();
    controller.abort(error);
    cancelTransport(error);
    output?.error(error);
    rejectPending(error);
  };
  const onAbort = () => stop(input.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const deadline = setTimeout(() => stop(budget.error('MODEL_STREAM_DEADLINE')), limits.deadlineMs);
  deadline.unref?.();
  let idle = setTimeout(() => stop(budget.error('MODEL_STREAM_IDLE_TIMEOUT')), limits.idleMs);
  idle.unref?.();
  const check = () => {
    if (input.signal?.aborted) onAbort();
    if (stopped) throw failure;
  };
  const observe = (event: Record<string, any>) => {
    check();
    try {
      budget.observe(event);
    } catch (error) {
      stop(error);
      throw error;
    }
    clearTimeout(idle);
    if (budget.terminal) dispose();
    else {
      idle = setTimeout(
        () => stop(budget.error('MODEL_STREAM_IDLE_TIMEOUT')),
        Math.max(0, limits.idleMs - (Date.now() - budget.lastProgressAt)),
      );
      idle.unref?.();
    }
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    if (stopped) throw failure;
    const pending = transport.execute({ ...input, signal: controller.signal });
    // 即使 transport 不响应 abort，迟到的响应也不得遗留连接或 body。
    void pending.then(
      (late) => {
        invalidate = late.invalidate;
        responseBody = late.response.body;
        if (stopped) cancelTransport(failure);
      },
      () => undefined,
    );
    const result = await Promise.race([pending, cancelled]);
    check();
    if (!result.response.body) {
      dispose();
      return { ...result, guard: { observe, stop, dispose, check, budget } };
    }
    reader = result.response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          output = value;
        },
        async pull(value) {
          try {
            const chunk = await Promise.race([reader!.read(), cancelled]);
            if (stopped) return;
            if (chunk.done) {
              dispose();
              value.close();
              return;
            }
            budget.observeBytes(chunk.value.byteLength);
            value.enqueue(chunk.value);
          } catch (error) {
            stop(error);
          }
        },
        cancel() {
          if (!budget.terminal) {
            stop(new DOMException('Consumer closed', 'AbortError'));
            return;
          }
          dispose();
          void reader?.cancel().catch(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
    return {
      ...result,
      response: new Response(body, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
      }),
      guard: { observe, stop, dispose, check, budget },
    };
  } catch (error) {
    stop(error);
    throw failure ?? error;
  }
}

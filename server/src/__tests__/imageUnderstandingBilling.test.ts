import { describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/chatCompletionsAdapter.js', () => ({
  ChatCompletionsModelAdapter: class {
    async *stream(request: { model: string }, context: { recordModelRequestDiagnostic?: (diagnostic: any) => Promise<void> }) {
      if (request.model === 'vision-fail') {
        await context.recordModelRequestDiagnostic?.({
          type: 'finished', modelRequestId: 'm1', attemptId: 'a1', attempt: 1,
          outcome: 'parse_error', durationMs: 1, usage: { inputTokens: 50, outputTokens: 5 },
        });
        throw new Error('provider failed');
      }
      yield { type: 'text_delta', content: '看见一张测试图片' };
      yield {
        type: 'completed',
        content: '看见一张测试图片',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }
  },
}));

vi.mock('../runtime/responsesApiAdapter.js', () => ({
  ResponsesApiAdapter: class {},
}));

import { analyzeImagesWithFallback } from '../runtime/imageUnderstanding.js';

describe('图片理解 Billing 门禁', () => {
  it('fallback 链每次真实模型调用前都重新授权', async () => {
    const authorizeModelTurn = vi.fn(async () => undefined);
    const attempts: Array<{ model: string; status: string; inputTokens?: number }> = [];

    const result = await analyzeImagesWithFallback(
      [{
        attachmentId: 'image-1',
        originalName: 'test.png',
        relativePath: 'uploads/test.png',
        mimeType: 'image/png',
        size: 128,
        isImage: true,
        modelRelativePath: 'uploads/.model-images/test-v1.png',
        modelMimeType: 'image/png',
      }] as any,
      [
        {
          model: 'vision-fail',
          connection: { apiKey: 'test-key' },
          providerOptions: { inputModalities: ['image'] },
        },
        {
          model: 'vision-ok',
          connection: { apiKey: 'test-key' },
          providerOptions: { inputModalities: ['image'] },
        },
      ] as any,
      {
        runId: 'run-1',
        sessionId: 'session-1',
        model: 'main-model',
        cwd: '/tmp',
        channelContext: { channel: 'web' },
        authorizeModelTurn,
      } as any,
      {
        onAttempt: (attempt) => {
          attempts.push({
            model: attempt.model,
            status: attempt.status,
            ...(attempt.usage?.inputTokens !== undefined ? { inputTokens: attempt.usage.inputTokens } : {}),
          });
        },
      },
    );

    expect(authorizeModelTurn).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([
      { model: 'vision-fail', status: 'failed', inputTokens: 50 },
      { model: 'vision-ok', status: 'completed', inputTokens: 100 },
    ]);
    expect(result?.model).toBe('vision-ok');
  });

  it('授权拒绝时不进入模型 stream，并停止继续 fallback', async () => {
    const authorizeModelTurn = vi.fn(async () => {
      throw new Error('[BILLING_RUN_LIMIT_EXCEEDED] 本次运行已达到积分上限');
    });

    await expect(analyzeImagesWithFallback(
      [{
        attachmentId: 'image-1',
        isImage: true,
        modelRelativePath: 'uploads/.model-images/test-v1.png',
        modelMimeType: 'image/png',
      }] as any,
      [{
        model: 'vision-ok',
        connection: { apiKey: 'test-key' },
        providerOptions: { inputModalities: ['image'] },
      }] as any,
      {
        runId: 'run-1',
        sessionId: 'session-1',
        model: 'main-model',
        cwd: '/tmp',
        channelContext: { channel: 'web' },
        authorizeModelTurn,
      } as any,
    )).rejects.toThrow(/BILLING_RUN_LIMIT_EXCEEDED/);

    expect(authorizeModelTurn).toHaveBeenCalledTimes(1);
  });
});

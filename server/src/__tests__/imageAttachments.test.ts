import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatCompletionsModelAdapter } from '../runtime/chatCompletionsAdapter.js';
import {
  buildModelUserContent,
  resolveInboundAttachments,
} from '../runtime/imageAttachments.js';
import { analyzeImagesWithFallback } from '../runtime/imageUnderstanding.js';
import { buildChatMessagesFromEvents } from '../runtime/legacyTranscriptProjection.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import type { ModelEvent, ModelVisionAnalysis, PlatformEvent } from '../runtime/types.js';

function chatSse(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function responsesSse(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<void> {
  for await (const _event of stream) {
    // 消费完整 SSE，确保 adapter 已构造并发送请求体。
  }
}

async function createUploadedPng(): Promise<{
  cwd: string;
  attachmentId: string;
  relativePath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-saas-image-'));
  const uploads = join(cwd, 'uploads');
  await mkdir(uploads, { recursive: true });
  const attachmentId = randomUUID();
  const fileName = `${attachmentId}_界面截图.png`;
  await copyFile(resolve(process.cwd(), '../web/public/favicon-32x32.png'), join(uploads, fileName));
  return { cwd, attachmentId, relativePath: `uploads/${fileName}` };
}

describe('图片附件 P1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('按 attachmentId 在当前 workspace 重解析，并忽略客户端 savedPath/MIME/size', async () => {
    const fixture = await createUploadedPng();
    const [attachment] = await resolveInboundAttachments([{
      attachmentId: fixture.attachmentId,
      originalName: '界面截图.png',
      savedPath: '/etc/passwd',
      relativePath: 'uploads/伪造路径.png',
      size: 1,
      mimeType: 'image/jpeg',
      isImage: true,
    }], { cwd: fixture.cwd, channel: 'web' });

    expect(attachment).toMatchObject({
      attachmentId: fixture.attachmentId,
      originalName: '界面截图.png',
      relativePath: fixture.relativePath,
      mimeType: 'image/png',
      isImage: true,
      width: 32,
      height: 32,
      modelMimeType: 'image/png',
    });
    expect(attachment.modelRelativePath).toMatch(/^uploads\/\.model-images\/[a-f0-9]{64}-v1\.png$/);
    expect(attachment.modelSizeBytes).toBeGreaterThan(0);
  });

  it('拒绝只有 image 声明、没有有效图片魔数的伪造附件', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-saas-image-invalid-'));
    const uploads = join(cwd, 'uploads');
    await mkdir(uploads, { recursive: true });
    const attachmentId = randomUUID();
    await writeFile(join(uploads, `${attachmentId}_fake.png`), 'not an image');

    await expect(resolveInboundAttachments([{
      attachmentId,
      originalName: 'fake.png',
      savedPath: '/tmp/ignored',
      relativePath: 'uploads/fake.png',
      size: 12,
      mimeType: 'image/png',
      isImage: true,
    }], { cwd, channel: 'web' })).rejects.toThrow('不是有效的受支持图片');
  });

  it('Chat Completions 将图片映射为 image_url；text-only 模型只接收辅助视觉摘要', async () => {
    const fixture = await createUploadedPng();
    const attachments = await resolveInboundAttachments([{
      attachmentId: fixture.attachmentId,
      originalName: '界面截图.png',
      savedPath: fixture.relativePath,
      relativePath: fixture.relativePath,
      size: 1,
      mimeType: 'image/png',
      isImage: true,
    }], { cwd: fixture.cwd, channel: 'web' });
    const summary: ModelVisionAnalysis = {
      model: 'vision-helper',
      attachmentIds: [fixture.attachmentId],
      content: '图片显示一个蓝色应用图标。',
    };
    const request = {
      model: 'model-under-test',
      messages: [{ role: 'user' as const, content: buildModelUserContent('请分析', attachments, summary) }],
      tools: [],
    };
    const context = {
      runId: 'run-image',
      sessionId: 'session-image',
      model: 'model-under-test',
      cwd: fixture.cwd,
      channelContext: { channel: 'web' as const },
    };

    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      chatSse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      chatSse('[DONE]'),
    ]));
    await collect(new ChatCompletionsModelAdapter(
      { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
      { inputModalities: ['text', 'image'] },
    ).stream(request, context));
    const nativeBody = JSON.parse(String((nativeFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(nativeBody.messages[0].content[0]).toMatchObject({
      type: 'image_url',
      image_url: { detail: 'high' },
    });
    expect(nativeBody.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(nativeBody)).not.toContain('图片显示一个蓝色应用图标');
    nativeFetch.mockRestore();

    const textFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      chatSse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      chatSse('[DONE]'),
    ]));
    await collect(new ChatCompletionsModelAdapter(
      { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
      { inputModalities: ['text'] },
    ).stream(request, context));
    const textBody = JSON.parse(String((textFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(textBody.messages[0].content).toContain('辅助视觉模型 vision-helper');
    expect(textBody.messages[0].content).toContain('图片显示一个蓝色应用图标');
    expect(textBody.messages[0].content).not.toContain('data:image/');
    textFetch.mockRestore();
  });

  it('Responses API 将图片映射为 input_image', async () => {
    const fixture = await createUploadedPng();
    const attachments = await resolveInboundAttachments([{
      attachmentId: fixture.attachmentId,
      originalName: '界面截图.png',
      savedPath: fixture.relativePath,
      relativePath: fixture.relativePath,
      size: 1,
      mimeType: 'image/png',
      isImage: true,
    }], { cwd: fixture.cwd, channel: 'web' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      responsesSse('response.created', { response: { id: 'resp_image', model: 'vision-model' } }),
      responsesSse('response.output_text.delta', { delta: 'ok' }),
      responsesSse('response.completed', {
        response: {
          id: 'resp_image',
          model: 'vision-model',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      'data: [DONE]\n\n',
    ]));

    await collect(new ResponsesApiAdapter(
      { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
      { protocol: 'responses', inputModalities: ['text', 'image'] },
    ).stream({
      model: 'vision-model',
      messages: [{ role: 'user', content: buildModelUserContent('请分析', attachments) }],
      tools: [],
    }, {
      runId: 'run-image',
      sessionId: 'session-image',
      model: 'vision-model',
      cwd: fixture.cwd,
      channelContext: { channel: 'web' },
    }));

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.input[0].content[0]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(body.input[0].content[0].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it('主模型不支持图片时，独立视觉链跳过无能力模型并记录成功尝试', async () => {
    const fixture = await createUploadedPng();
    const attachments = await resolveInboundAttachments([{
      attachmentId: fixture.attachmentId,
      originalName: '界面截图.png',
      savedPath: fixture.relativePath,
      relativePath: fixture.relativePath,
      size: 1,
      mimeType: 'image/png',
      isImage: true,
    }], { cwd: fixture.cwd, channel: 'web' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      chatSse({ choices: [{ delta: { content: '图中是一个蓝色应用图标。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4 } }),
      chatSse('[DONE]'),
    ]));
    const attempts: Array<{ model: string; status: string }> = [];

    const result = await analyzeImagesWithFallback(attachments, [
      {
        model: '错误配置的文本模型',
        connection: { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
        providerOptions: { inputModalities: ['text'] },
      },
      {
        model: 'vision-helper',
        connection: { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
        providerOptions: { inputModalities: ['text', 'image'] },
      },
    ], {
      runId: 'run-vision',
      sessionId: 'session-vision',
      model: 'text-main',
      cwd: fixture.cwd,
      channelContext: { channel: 'web' },
    }, {
      onAttempt: (attempt) => {
        attempts.push({ model: attempt.model, status: attempt.status });
      },
    });

    expect(result).toEqual({
      model: 'vision-helper',
      attachmentIds: [fixture.attachmentId],
      content: '图中是一个蓝色应用图标。',
    });
    expect(attempts).toEqual([
      { model: '错误配置的文本模型', status: 'failed' },
      { model: 'vision-helper', status: 'completed' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('full replay 只保留最近 3 个图片轮次的像素内容', () => {
    const events: PlatformEvent[] = Array.from({ length: 4 }, (_, index) => ({
      id: `event-${index}`,
      timestamp: `2026-07-14T0${index}:00:00.000Z`,
      type: 'user_message' as const,
      runId: `run-${index}`,
      sessionId: 'session-history',
      content: `第 ${index + 1} 张图`,
      attachments: [{
        attachmentId: `attachment-${index}`,
        originalName: `${index}.png`,
        relativePath: `uploads/${index}.png`,
        sizeBytes: 10,
        mimeType: 'image/png',
        isImage: true,
        modelRelativePath: `uploads/.model-images/${index}.png`,
        modelMimeType: 'image/png',
        modelSizeBytes: 10,
      }],
    }));

    const messages = buildChatMessagesFromEvents(events);
    expect(typeof messages[0]?.content).toBe('string');
    expect(messages[0]?.content).toContain('历史图片已从活跃视觉上下文移除');
    expect(messages.slice(1).every((message) => Array.isArray(message.content))).toBe(true);
  });
});

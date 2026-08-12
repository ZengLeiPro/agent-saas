import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatCompletionsModelAdapter } from '../runtime/chatCompletionsAdapter.js';
import {
  buildModelUserContent,
  readImagePartOrPlaceholder,
  resolveInboundAttachments,
} from '../runtime/imageAttachments.js';
import { InMemoryImageBlobStore, setImageBlobStore } from '../runtime/imageBlobStore.js';
import { analyzeImagesWithFallback } from '../runtime/imageUnderstanding.js';
import { buildChatMessagesFromEvents } from '../runtime/legacyTranscriptProjection.js';
import { ResponsesApiAdapter } from '../runtime/responsesApiAdapter.js';
import type {
  ModelAttachmentRef,
  ModelEvent,
  ModelUserContent,
  ModelUserContentPart,
  ModelVisionAnalysis,
  PlatformEvent,
} from '../runtime/types.js';

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

async function resolveFixtureAttachments(
  fixture: { cwd: string; attachmentId: string; relativePath: string },
): Promise<ModelAttachmentRef[]> {
  return resolveInboundAttachments([{
    attachmentId: fixture.attachmentId,
    originalName: '界面截图.png',
    savedPath: fixture.relativePath,
    relativePath: fixture.relativePath,
    size: 1,
    mimeType: 'image/png',
    isImage: true,
  }], { cwd: fixture.cwd, channel: 'web' });
}

function imagePartOf(content: ModelUserContent): Extract<ModelUserContentPart, { type: 'image_attachment' }> {
  if (typeof content === 'string') throw new Error('期望多模态内容，实际是纯文本');
  const part = content.find((item) => item.type === 'image_attachment');
  if (!part || part.type !== 'image_attachment') throw new Error('未找到 image_attachment part');
  return part;
}

describe('图片附件 P1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setImageBlobStore(undefined);
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

  it('Read 工具图片在 Chat Completions 与 Responses 中作为视觉输入紧跟工具结果', async () => {
    const fixture = await createUploadedPng();
    const attachments = await resolveFixtureAttachments(fixture);
    const image = imagePartOf(buildModelUserContent('unused', attachments));
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: 'call-read-image',
          type: 'function' as const,
          function: { name: 'Read', arguments: '{"path":"界面.png"}' },
        }],
      },
      {
        role: 'tool' as const,
        tool_call_id: 'call-read-image',
        content: 'Read image 界面.png (image/png). The image is attached as visual input.',
        images: [image],
      },
    ];
    const context = {
      runId: 'run-tool-image',
      sessionId: 'session-tool-image',
      model: 'vision-model',
      cwd: fixture.cwd,
      channelContext: { channel: 'web' as const },
    };

    const chatFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      chatSse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      chatSse('[DONE]'),
    ]));
    await collect(new ChatCompletionsModelAdapter(
      { apiKey: 'k', baseUrl: 'https://example.invalid/v1' },
      { inputModalities: ['text', 'image'] },
    ).stream({ model: 'vision-model', messages, tools: [] }, context));
    const chatBody = JSON.parse(String((chatFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(chatBody.messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(chatBody.messages[2].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    chatFetch.mockRestore();

    const responsesFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseStream([
      responsesSse('response.created', { response: { id: 'resp_tool_image', model: 'vision-model' } }),
      responsesSse('response.output_text.delta', { delta: 'ok' }),
      responsesSse('response.completed', {
        response: {
          id: 'resp_tool_image',
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
    ).stream({ model: 'vision-model', messages, tools: [] }, context));
    const responsesBody = JSON.parse(String((responsesFetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(responsesBody.input.map((item: { type: string }) => item.type))
      .toEqual(['function_call', 'function_call_output', 'message']);
    expect(responsesBody.input[2].content[0]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(responsesBody.input[2].content[0].image_url).toMatch(/^data:image\/png;base64,/);
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

  it('历史重放的图片 part 带 historical 标记', () => {
    const events: PlatformEvent[] = [{
      id: 'event-历史标记',
      timestamp: '2026-08-01T08:00:00.000Z',
      type: 'user_message' as const,
      runId: 'run-历史标记',
      sessionId: 'session-历史标记',
      content: '这是什么',
      attachments: [{
        attachmentId: 'attachment-历史',
        originalName: 'a.png',
        relativePath: 'uploads/a.png',
        sizeBytes: 10,
        mimeType: 'image/png',
        isImage: true,
        modelRelativePath: 'uploads/.model-images/a.png',
        modelMimeType: 'image/png',
        modelSizeBytes: 10,
      }],
    }];

    const [message] = buildChatMessagesFromEvents(events);
    const parts = message?.content as ModelUserContentPart[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.find((part) => part.type === 'image_attachment')).toMatchObject({ historical: true });
  });

  it('uploads 被清空后仍能从 blob 副本还原历史图片', async () => {
    setImageBlobStore(new InMemoryImageBlobStore());
    const fixture = await createUploadedPng();
    const part = imagePartOf(buildModelUserContent(
      '请分析',
      await resolveFixtureAttachments(fixture),
      undefined,
      { historical: true },
    ));

    // 模拟用户点「清空全部附件」：uploads/ 下含 .model-images 一并消失
    await rm(join(fixture.cwd, 'uploads'), { recursive: true, force: true });

    const result = await readImagePartOrPlaceholder(fixture.cwd, part);
    expect(typeof result).toBe('string');
    expect(result as string).toMatch(/^data:image\/png;base64,/);
  });

  it('blob 上线前就存在的图片，被读到时懒回填出副本', async () => {
    const store = new InMemoryImageBlobStore();
    const fixture = await createUploadedPng();
    // 上传发生在 blob store 生效之前：只有文件，没有副本
    const attachments = await resolveFixtureAttachments(fixture);
    const part = imagePartOf(buildModelUserContent('请分析', attachments, undefined, { historical: true }));
    setImageBlobStore(store);

    expect(await store.get(fixture.cwd, part.relativePath.split('/').pop()!)).toBeUndefined();
    await readImagePartOrPlaceholder(fixture.cwd, part);
    await vi.waitFor(async () => {
      expect(await store.get(fixture.cwd, part.relativePath.split('/').pop()!)).toBeDefined();
    });

    await rm(join(fixture.cwd, 'uploads'), { recursive: true, force: true });
    expect(typeof await readImagePartOrPlaceholder(fixture.cwd, part)).toBe('string');
  });

  it('blob 按 workspace 隔离，不跨工作区命中', async () => {
    setImageBlobStore(new InMemoryImageBlobStore());
    const fixture = await createUploadedPng();
    const part = imagePartOf(buildModelUserContent(
      '请分析',
      await resolveFixtureAttachments(fixture),
      undefined,
      { historical: true },
    ));
    await rm(join(fixture.cwd, 'uploads'), { recursive: true, force: true });

    const otherCwd = await mkdtemp(join(tmpdir(), 'agent-saas-image-other-'));
    await expect(readImagePartOrPlaceholder(otherCwd, part))
      .resolves.toMatchObject({ placeholder: expect.stringContaining('已不可用') });
  });

  it('历史图片彻底缺失时降级为文本占位，本轮图片缺失仍 fail-fast', async () => {
    setImageBlobStore(undefined);
    const fixture = await createUploadedPng();
    const attachments = await resolveFixtureAttachments(fixture);
    const historicalPart = imagePartOf(buildModelUserContent('历史', attachments, undefined, { historical: true }));
    const currentPart = imagePartOf(buildModelUserContent('本轮', attachments));
    await rm(join(fixture.cwd, 'uploads'), { recursive: true, force: true });

    await expect(readImagePartOrPlaceholder(fixture.cwd, historicalPart))
      .resolves.toMatchObject({ placeholder: expect.stringContaining('界面截图.png') });
    await expect(readImagePartOrPlaceholder(fixture.cwd, currentPart))
      .rejects.toThrow('ATTACHMENT_MISSING');
  });
});

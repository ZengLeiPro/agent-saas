import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ImageGenToolProvider,
  generateImageToolDescriptor,
  type ImageGenToolProviderOptions,
  type ResolvedImageGenToolsConfig,
} from '../agent/imageGenToolProvider.js';
import { configureImageGenPricing } from '../data/usage/imageGenPricing.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

function baseConfig(): ResolvedImageGenToolsConfig {
  return {
    enabled: true,
    gptImage2: { baseUrl: 'https://proxy.example/v1', apiKey: 'cliproxy-secret-key-123' },
    seedream: { apiKey: 'ark-secret-key-456' },
  };
}

function okImageResponse(count = 1, revisedPrompt?: string) {
  return new Response(JSON.stringify({
    data: Array.from({ length: count }, () => ({
      b64_json: PNG_BASE64,
      ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}),
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeContext(workspaceRoot: string): ToolCallContext {
  return {
    channelContext: { channel: 'web', user: { id: 'u1', username: 'alice', tenantId: 'wain-test' } } as any,
    workspace: {
      root: workspaceRoot,
      userId: 'u1',
      username: 'alice',
      tenantId: 'wain-test',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    },
    sessionId: 'session-1',
    runId: 'run-1',
  };
}

function makeBillingService(overrides: Partial<{
  afford: { ok: true } | { ok: false; reason: string };
  billable: boolean;
}> = {}) {
  return {
    assertTenantCanAffordFixedFee: vi.fn(async () => overrides.afford ?? { ok: true }),
    isTenantBillable: vi.fn(async () => overrides.billable ?? true),
  };
}

function makeProvider(overrides: Partial<ImageGenToolProviderOptions> = {}) {
  const fetchImpl = overrides.fetchImpl ?? (vi.fn(async () => okImageResponse()) as unknown as typeof fetch);
  const billing = makeBillingService();
  const appendPlatformEvent = vi.fn(async () => undefined);
  const provider = new ImageGenToolProvider({
    config: baseConfig(),
    billingService: () => billing as any,
    appendPlatformEvent,
    isImageGenEnabledForTenant: () => true,
    fetchImpl,
    retryDelaysMs: [1, 1, 1],
    ...overrides,
  });
  return { provider, fetchImpl: fetchImpl as ReturnType<typeof vi.fn>, billing, appendPlatformEvent };
}

function invokeInput(input: Record<string, unknown>) {
  return {
    toolId: 'GenerateImage',
    input,
    authorization: { approved: true, source: 'policy_auto' as const },
  };
}

describe('ImageGenToolProvider', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'image-gen-ws-'));
    configureImageGenPricing(undefined); // 恢复内置默认定价
  });

  afterEach(() => {
    configureImageGenPricing(undefined);
    vi.restoreAllMocks();
  });

  it('exposes the descriptor with server-generated output path guarantees', () => {
    expect(generateImageToolDescriptor.risk).toBe('safe');
    expect(generateImageToolDescriptor.approvalMode).toBe('never');
    expect(generateImageToolDescriptor.auditCategory).toBe('media.imageGenerate');
    // schema 不接受任意落盘路径参数（risk:'safe' 的前提）
    expect(Object.keys(generateImageToolDescriptor.schema.shape)).not.toContain('path');
    expect(Object.keys(generateImageToolDescriptor.schema.shape)).not.toContain('outputDir');
  });

  it('hides the tool when the tenant feature gate is off, shows it when on', () => {
    const { provider: gated } = makeProvider({ isImageGenEnabledForTenant: () => false });
    expect(gated.list(makeContext(workspaceRoot))).toEqual([]);

    const { provider: open } = makeProvider();
    expect(open.list(makeContext(workspaceRoot)).map((t) => t.id)).toEqual(['GenerateImage']);
  });

  it('rejects invoke defensively when the tenant gate is off (no fetch, no event)', async () => {
    const { provider, fetchImpl, appendPlatformEvent } = makeProvider({ isImageGenEnabledForTenant: () => false });
    await expect(
      provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/未开通 AI 生图能力/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appendPlatformEvent).not.toHaveBeenCalled();
  });

  it('generates via gpt-image-2, writes into assets/generated/<date>/ and appends a metered_tool_usage event', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://proxy.example/v1/images/generations');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cliproxy-secret-key-123');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', size: '1024x1024', quality: 'auto' });
      return okImageResponse(1, 'a fluffy cat');
    }) as unknown as typeof fetch;
    const { provider, appendPlatformEvent, billing } = makeProvider({ fetchImpl });

    const result = await provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot));
    expect(result).toBeDefined();
    const payload = JSON.parse(result!.content);
    expect(payload.status).toBe('ok');
    expect(payload.engine).toBe('gpt-image-2');
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]).toMatch(/^assets\/generated\/\d{8}\/img-[0-9a-f]{8}\.png$/);
    expect(payload.creditsCharged).toBe(400);
    expect(payload.revisedPrompt).toBe('a fluffy cat');
    // key 绝不泄漏进模型可见内容
    expect(result!.content).not.toContain('cliproxy-secret-key-123');

    // 文件确实写在 workspace 内 server 生成的路径下
    const dateDir = payload.images[0].split('/')[2];
    expect(readdirSync(join(workspaceRoot, 'assets', 'generated', dateDir))).toHaveLength(1);

    // 预检发生在生成之前，事件在成功之后
    expect(billing.assertTenantCanAffordFixedFee).toHaveBeenCalledWith('wain-test', 400_000_000);
    expect(appendPlatformEvent).toHaveBeenCalledTimes(1);
    expect(appendPlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'metered_tool_usage',
        runId: 'run-1',
        sessionId: 'session-1',
        toolId: 'GenerateImage',
        sku: 'image_gen:gpt-image-2',
        quantity: 1,
        unitCreditsMicro: 400_000_000,
        unitCostYuanMicro: 1_500_000,
      }),
      { tenantId: 'wain-test' },
    );
  });

  it('fails closed on insufficient balance: no API call, no event, tool error mentions credits', async () => {
    const billing = makeBillingService({ afford: { ok: false, reason: '组织积分余额不足，当前计费策略已启用硬封顶。' } });
    const { provider, fetchImpl, appendPlatformEvent } = makeProvider({ billingService: () => billing as any });

    await expect(
      provider.invoke(invokeInput({ prompt: 'a cat', count: 2 }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/未扣费.*余额不足.*800 积分/s);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appendPlatformEvent).not.toHaveBeenCalled();
  });

  it('does not charge internal / billing-disabled tenants but still records the event', async () => {
    const billing = makeBillingService({ billable: false });
    const { provider, appendPlatformEvent } = makeProvider({ billingService: () => billing as any });

    const result = await provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot));
    const payload = JSON.parse(result!.content);
    expect(payload.creditsCharged).toBe(0);
    expect(payload.billingNote).toContain('未扣积分');
    // 事件照记（usage 照记内部可见；debit 由投影按 policy 跳过）
    expect(appendPlatformEvent).toHaveBeenCalledTimes(1);
  });

  it('retries gpt-image-2 on retryable failures then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('auth_unavailable', { status: 503 });
      return okImageResponse();
    }) as unknown as typeof fetch;
    const { provider } = makeProvider({ fetchImpl });

    const result = await provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot));
    expect(JSON.parse(result!.content).status).toBe('ok');
    expect(calls).toBe(2);
  });

  it('surfaces a seedream hint after gpt-image-2 exhausts retries, without charging', async () => {
    const fetchImpl = vi.fn(async () => new Response('auth_unavailable', { status: 503 })) as unknown as typeof fetch;
    const { provider, appendPlatformEvent } = makeProvider({ fetchImpl, retryDelaysMs: [1, 1] });

    await expect(
      provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/model:"seedream"/);
    // 重试尽失败 = 1 次原始 + 2 次重试
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(appendPlatformEvent).not.toHaveBeenCalled();
  });

  it('generates via seedream with Ark defaults and per-engine pricing', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'doubao-seedream-5.0-lite',
        prompt: '一只猫',
        size: '2560x1440',
        n: 2,
        response_format: 'b64_json',
        watermark: false,
      });
      return okImageResponse(2);
    }) as unknown as typeof fetch;
    const { provider, appendPlatformEvent } = makeProvider({ fetchImpl });

    const result = await provider.invoke(
      invokeInput({ prompt: '一只猫', model: 'seedream', aspectRatio: '16:9', count: 2 }),
      makeContext(workspaceRoot),
    );
    const payload = JSON.parse(result!.content);
    expect(payload.engine).toBe('seedream');
    expect(payload.images).toHaveLength(2);
    expect(payload.creditsCharged).toBe(200); // 100 积分/张 × 2
    expect(appendPlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sku: 'image_gen:seedream', quantity: 2, unitCreditsMicro: 100_000_000 }),
      { tenantId: 'wain-test' },
    );
  });

  it('uses runtime-configured pricing immediately (admin hot update)', async () => {
    configureImageGenPricing({ 'gpt-image-2': { creditsPerImage: 250, costYuanPerImage: 1.2 } });
    const { provider, billing, appendPlatformEvent } = makeProvider();

    const result = await provider.invoke(invokeInput({ prompt: 'a cat' }), makeContext(workspaceRoot));
    expect(JSON.parse(result!.content).creditsCharged).toBe(250);
    expect(billing.assertTenantCanAffordFixedFee).toHaveBeenCalledWith('wain-test', 250_000_000);
    expect(appendPlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({ unitCreditsMicro: 250_000_000, unitCostYuanMicro: 1_200_000 }),
      { tenantId: 'wain-test' },
    );
  });

  it('rejects reference images escaping the workspace, without calling the API', async () => {
    const { provider, fetchImpl } = makeProvider();
    await expect(
      provider.invoke(
        invokeInput({ prompt: 'edit', refImages: ['../../etc/passwd'] }),
        makeContext(workspaceRoot),
      ),
    ).rejects.toThrow(/越界/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes reference-image requests to /images/edits as multipart', async () => {
    mkdirSync(join(workspaceRoot, 'uploads'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'uploads', 'ref.png'), Buffer.from('ref-bytes'));
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://proxy.example/v1/images/edits');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2');
      expect(form.getAll('image[]')).toHaveLength(1);
      return okImageResponse();
    }) as unknown as typeof fetch;
    const { provider } = makeProvider({ fetchImpl });

    const result = await provider.invoke(
      invokeInput({ prompt: 'restyle it', refImages: ['uploads/ref.png'] }),
      makeContext(workspaceRoot),
    );
    expect(JSON.parse(result!.content).status).toBe('ok');
  });

  it('serializes concurrent gpt-image-2 batches through the global single-flight queue', async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => { resolvers.push(resolve); }),
    ) as unknown as typeof fetch;
    const { provider } = makeProvider({ fetchImpl });

    const first = provider.invoke(invokeInput({ prompt: 'one' }), makeContext(workspaceRoot));
    const second = provider.invoke(invokeInput({ prompt: 'two' }), makeContext(workspaceRoot));

    // 第二个请求必须等第一个批次完成才进入订阅池
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    resolvers[0]!(okImageResponse());
    await first;
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(okImageResponse());
    await second;
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('returns undefined for unrelated tools so the provider chain continues', async () => {
    const { provider } = makeProvider();
    await expect(
      provider.invoke({ toolId: 'WebFetch', input: {}, authorization: { approved: true, source: 'policy_auto' } }, makeContext(workspaceRoot)),
    ).resolves.toBeUndefined();
  });
});

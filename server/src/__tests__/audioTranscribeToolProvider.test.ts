import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AudioTranscribeToolProvider,
  audioTranscribeToolDescriptor,
  type AudioTranscribeToolProviderOptions,
  type ResolvedAudioTranscribeToolsConfig,
} from '../agent/audioTranscribeToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

function baseConfig(): ResolvedAudioTranscribeToolsConfig {
  return {
    enabled: true,
    sttConfig: {
      apiKey: 'dashscope-test-key',
      model: 'fun-asr',
      ossAccessKeyId: 'oss-id',
      ossAccessKeySecret: 'oss-secret',
    },
    pricing: { creditsPerCall: 12, costYuanPerCall: 0.08 },
  };
}

function makeContext(workspaceRoot: string): ToolCallContext {
  return {
    channelContext: {
      channel: 'web',
      user: { id: 'u1', username: 'alice', tenantId: 'tenant-1' },
    } as any,
    workspace: {
      root: workspaceRoot,
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    },
    sessionId: 'session-1',
    runId: 'run-1',
    invocationId: 'invocation-1',
  };
}

function makeBilling(overrides: Partial<{
  afford: { ok: true } | { ok: false; reason: string };
  billable: boolean;
}> = {}) {
  return {
    authorizeFixedFee: vi.fn(async () => overrides.afford?.ok === false
      ? { ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED', reason: overrides.afford.reason }
      : { ok: true }),
    assertTenantCanAffordFixedFee: vi.fn(async () => overrides.afford ?? { ok: true }),
    isTenantBillable: vi.fn(async () => overrides.billable ?? true),
    chargeFixedDebit: vi.fn(async () => null),
  };
}

function invokeInput(input: Record<string, unknown>) {
  return {
    toolId: 'AudioTranscribe',
    input,
    authorization: { approved: true, source: 'policy_auto' as const },
  };
}

describe('AudioTranscribeToolProvider', () => {
  let workspaceRoot: string;
  let roots: string[];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audio-transcribe-ws-'));
    roots = [workspaceRoot];
    mkdirSync(join(workspaceRoot, 'uploads'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'uploads', 'meeting.wav'), 'fake-audio');
  });

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProvider(overrides: Partial<AudioTranscribeToolProviderOptions> = {}) {
    const billing = makeBilling();
    const transcribe = vi.fn(async () => ({ text: '第一句\n第二句', duration: 12_345 }));
    const appendPlatformEvent = vi.fn(async () => undefined);
    const provider = new AudioTranscribeToolProvider({
      config: baseConfig(),
      billingService: () => billing as any,
      transcribe,
      appendPlatformEvent,
      ...overrides,
    });
    return { provider, billing, transcribe, appendPlatformEvent };
  }

  it('exposes the media descriptor and constrained input schema', () => {
    expect(audioTranscribeToolDescriptor).toMatchObject({
      id: 'AudioTranscribe',
      name: 'AudioTranscribe',
      category: 'media',
      label: '语音转文字',
      risk: 'safe',
      approvalMode: 'never',
    });
    expect(Object.keys(audioTranscribeToolDescriptor.schema.shape)).toEqual([
      'input',
      'speaker',
      'timestamps',
    ]);
    const { provider } = makeProvider();
    expect(provider.list().map(tool => tool.id)).toEqual(['AudioTranscribe']);
  });

  it('rejects lexical and symlink path escapes before transcription', async () => {
    const { provider, transcribe } = makeProvider();
    await expect(
      provider.invoke(invokeInput({ input: '../secret.wav' }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/路径越界/);

    const outsideRoot = mkdtempSync(join(tmpdir(), 'audio-transcribe-outside-'));
    roots.push(outsideRoot);
    writeFileSync(join(outsideRoot, 'secret.wav'), 'secret');
    symlinkSync(join(outsideRoot, 'secret.wav'), join(workspaceRoot, 'uploads', 'linked.wav'));
    await expect(
      provider.invoke(invokeInput({ input: 'uploads/linked.wav' }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/symlink.*工作区外/);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('persists a unique transcript then appends the fixed-fee usage event', async () => {
    const { provider, billing, transcribe, appendPlatformEvent } = makeProvider();
    const result = await provider.invoke(
      invokeInput({ input: 'uploads/meeting.wav', speaker: true, timestamps: true }),
      makeContext(workspaceRoot),
    );
    const payload = JSON.parse(result!.content);

    expect(payload).toMatchObject({
      text: '第一句\n第二句',
      durationMs: 12_345,
      model: 'fun-asr',
      creditsCharged: 12,
      pricingNote: '12 积分/次',
    });
    expect(payload.outputPath).toMatch(/^assets\/\d{8}\/meeting-转写-[0-9a-f]{8}\.txt$/);
    expect(readFileSync(join(workspaceRoot, payload.outputPath), 'utf8')).toBe('第一句\n第二句');
    expect(result!.presentation?.title).toBe('语音转文字');
    expect(transcribe).toHaveBeenCalledWith(
      join(workspaceRoot, 'uploads', 'meeting.wav'),
      expect.objectContaining({ model: 'fun-asr' }),
      expect.objectContaining({ speaker: true, timestamps: true }),
    );
    expect(billing.authorizeFixedFee).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      runId: 'run-1',
      creditsMicro: 12_000_000,
    }));
    expect(appendPlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'metered_tool_usage',
        toolId: 'AudioTranscribe',
        sku: 'audio_transcribe:fun-asr',
        quantity: 1,
        unitCreditsMicro: 12_000_000,
        unitCostYuanMicro: 80_000,
        billingChargeKey: 'debit:tool:direct:v1:invocation-1:audio',
      }),
      { tenantId: 'tenant-1' },
    );
    expect(billing.chargeFixedDebit).not.toHaveBeenCalled();
  });

  it('rejects an assets symlink that points outside the workspace', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'audio-transcribe-output-outside-'));
    roots.push(outsideRoot);
    symlinkSync(outsideRoot, join(workspaceRoot, 'assets'));
    const { provider, appendPlatformEvent } = makeProvider();

    await expect(provider.invoke(
      invokeInput({ input: 'uploads/meeting.wav' }),
      makeContext(workspaceRoot),
    )).rejects.toThrow(/输出目录越界/);
    expect(appendPlatformEvent).not.toHaveBeenCalled();
    expect(readFileSync(join(workspaceRoot, 'uploads', 'meeting.wav'), 'utf8')).toBe('fake-audio');
  });

  it('does not persist or charge when cancellation arrives after transcription', async () => {
    const controller = new AbortController();
    const transcribe = vi.fn(async () => {
      controller.abort(new Error('cancelled'));
      return { text: '不应落盘', duration: 1_000 };
    });
    const { provider, appendPlatformEvent } = makeProvider({ transcribe });
    const context = { ...makeContext(workspaceRoot), signal: controller.signal };

    await expect(provider.invoke(
      invokeInput({ input: 'uploads/meeting.wav' }),
      context,
    )).rejects.toThrow('cancelled');
    expect(appendPlatformEvent).not.toHaveBeenCalled();
  });

  it('removes a transcript written while cancellation arrives and skips billing', async () => {
    const controller = new AbortController();
    const transcribe = vi.fn(async () => {
      setTimeout(() => controller.abort(new Error('cancelled-during-write')), 0);
      return { text: '大'.repeat(2_000_000), duration: 1_000 };
    });
    const { provider, appendPlatformEvent } = makeProvider({ transcribe });
    const context = { ...makeContext(workspaceRoot), signal: controller.signal };

    await expect(provider.invoke(
      invokeInput({ input: 'uploads/meeting.wav' }),
      context,
    )).rejects.toThrow('cancelled-during-write');
    expect(appendPlatformEvent).not.toHaveBeenCalled();
    const assetsDir = join(workspaceRoot, 'assets');
    const files = existsSync(assetsDir) ? readdirSync(assetsDir, { recursive: true }) : [];
    expect(files.some((entry) => String(entry).endsWith('.txt'))).toBe(false);
  });

  it('keeps long transcripts in the output file and truncates only the inline tool payload', async () => {
    const longText = '转'.repeat(20_100);
    const { provider } = makeProvider({
      transcribe: vi.fn(async () => ({ text: longText, duration: 1_000 })),
    });
    const result = await provider.invoke(
      invokeInput({ input: 'uploads/meeting.wav' }),
      makeContext(workspaceRoot),
    );
    const payload = JSON.parse(result!.content);
    expect(payload.textTruncated).toBe(true);
    expect(payload.characterCount).toBe(20_100);
    expect(payload.text).toContain('[工具结果已截断');
    expect(readFileSync(join(workspaceRoot, payload.outputPath), 'utf8')).toBe(longText);
  });

  it('does not call transcription or append usage when balance is insufficient', async () => {
    const billing = makeBilling({
      afford: { ok: false, reason: '组织积分余额不足，当前计费策略已启用硬封顶。' },
    });
    const { provider, transcribe, appendPlatformEvent } = makeProvider({
      billingService: () => billing as any,
    });
    await expect(
      provider.invoke(invokeInput({ input: 'uploads/meeting.wav' }), makeContext(workspaceRoot)),
    ).rejects.toThrow(/未扣费.*余额不足.*12 积分/s);
    expect(transcribe).not.toHaveBeenCalled();
    expect(appendPlatformEvent).not.toHaveBeenCalled();
    expect(billing.chargeFixedDebit).not.toHaveBeenCalled();
  });

  it('does not charge or append usage when transcription fails', async () => {
    const billing = makeBilling();
    const appendPlatformEvent = vi.fn(async () => undefined);
    const transcribe = vi.fn(async () => { throw new Error('DashScope unavailable'); });
    const { provider } = makeProvider({
      billingService: () => billing as any,
      appendPlatformEvent,
      transcribe,
    });

    await expect(
      provider.invoke(invokeInput({ input: 'uploads/meeting.wav' }), makeContext(workspaceRoot)),
    ).rejects.toThrow('DashScope unavailable');
    expect(appendPlatformEvent).not.toHaveBeenCalled();
    expect(billing.chargeFixedDebit).not.toHaveBeenCalled();
  });

  it('records usage but charges zero credits for a non-billable tenant', async () => {
    const billing = makeBilling({ billable: false });
    const { provider, appendPlatformEvent } = makeProvider({ billingService: () => billing as any });
    const result = await provider.invoke(
      invokeInput({ input: 'https://cdn.example/audio/demo.mp3' }),
      makeContext(workspaceRoot),
    );
    const payload = JSON.parse(result!.content);

    expect(payload.creditsCharged).toBe(0);
    expect(payload.billingNote).toContain('未扣积分');
    expect(appendPlatformEvent).toHaveBeenCalledWith(
      expect.objectContaining({ unitCreditsMicro: 0, unitCostYuanMicro: 80_000 }),
      { tenantId: 'tenant-1' },
    );
    expect(billing.chargeFixedDebit).not.toHaveBeenCalled();
  });
});

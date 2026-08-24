import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, posix } from 'node:path';
import { z } from 'zod';

import type { BillingService } from '../data/billing/service.js';
import { CREDIT_MICRO, YUAN_MICRO } from '../data/billing/types.js';
import {
  DEFAULT_STT_MODEL,
  speechToText,
  type SttConfig,
  type SttOptions,
  type SttResult,
} from '../integrations/stt/sttClient.js';
import type { EventAppendContext, PlatformEventInput } from '../runtime/types.js';
import { openTrustedFile, removeTrustedPath, writeTrustedFile } from '../security/trustedFile.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

export interface AudioTranscribePricing {
  creditsPerCall: number;
  costYuanPerCall: number;
}

/** 装配层已解析密钥的最小运行配置。 */
export interface ResolvedAudioTranscribeToolsConfig {
  enabled: boolean;
  sttConfig: SttConfig;
  pricing: AudioTranscribePricing;
}

export type ResolvedAudioTranscribeConfig = ResolvedAudioTranscribeToolsConfig;
export type AudioTranscribeFunction = (
  input: string,
  config: SttConfig,
  options?: SttOptions,
) => Promise<SttResult>;

export interface AudioTranscribeToolProviderOptions {
  config: ResolvedAudioTranscribeToolsConfig;
  billingService?: () => BillingService | undefined;
  appendPlatformEvent?: (event: PlatformEventInput, context?: EventAppendContext) => Promise<unknown>;
  /** 测试注入；生产默认使用 speechToText。 */
  transcribe?: AudioTranscribeFunction;
  logger?: { warn?: (message: string) => void };
}

const audioTranscribeSchema = z.object({
  input: z.string().min(1).max(8_000)
    .describe('工作区内的相对音频/视频文件路径，或公开可访问的 http/https 音频直链。'),
  speaker: z.boolean().optional()
    .describe('是否启用说话人分离并在每句前输出说话人标签。默认 false。'),
  timestamps: z.boolean().optional()
    .describe('是否在每句前输出 [HH:MM:SS] 时间戳。默认 false。'),
});

export type AudioTranscribeInput = z.infer<typeof audioTranscribeSchema>;

export const audioTranscribeToolDescriptor: ToolDescriptor<AudioTranscribeInput> = {
  id: 'AudioTranscribe',
  name: 'AudioTranscribe',
  displayName: 'AudioTranscribe',
  description: loadToolDescription('AudioTranscribe'),
  schema: audioTranscribeSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'media.audioTranscribe',
  category: 'media',
  label: '语音转文字',
};

function resolveTenantId(context?: ToolCallContext): string | undefined {
  return context?.channelContext?.user?.tenantId
    ?? context?.channelContext?.sessionOwner?.tenantId
    ?? context?.workspace?.tenantId;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function parseHttpUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function dateDirectory(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function safeOriginalStem(input: string, url?: URL): string {
  let original: string;
  if (url) {
    try {
      original = basename(decodeURIComponent(url.pathname));
    } catch {
      original = basename(url.pathname);
    }
  } else {
    original = basename(input);
  }
  const stem = basename(original, extname(original))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return stem || 'audio';
}

const MAX_INLINE_TRANSCRIPT_CHARS = 20_000;

export class AudioTranscribeToolProvider implements ToolProvider {
  private readonly transcribe: AudioTranscribeFunction;

  constructor(private readonly options: AudioTranscribeToolProviderOptions) {
    this.transcribe = options.transcribe ?? speechToText;
  }

  list(): ToolDescriptor[] {
    return this.options.config.enabled ? [audioTranscribeToolDescriptor] : [];
  }

  async invoke<TInput>(
    call: AuthorizedToolCall<TInput>,
    context: ToolCallContext,
  ): Promise<ToolResult | undefined> {
    if (call.toolId !== audioTranscribeToolDescriptor.id) return undefined;
    if (!this.options.config.enabled) return undefined;

    const input = audioTranscribeToolDescriptor.schema.parse(call.input) as AudioTranscribeInput;
    const resolvedInput = await this.resolveInput(input.input, context.workspace.root);
    const tenantId = resolveTenantId(context);
    const billing = this.options.billingService?.();
    const pricing = this.options.config.pricing;
    const creditsMicro = Math.round(pricing.creditsPerCall * CREDIT_MICRO);
    const costYuanMicro = Math.round(pricing.costYuanPerCall * YUAN_MICRO);
    const userId = context.channelContext.user?.id ?? context.channelContext.sessionOwner?.id;
    const invocation = context.invocationId ?? context.toolCallId ?? randomUUID();
    const chargeKey = `debit:tool:direct:v1:${invocation}:audio`;
    let billable = false;

    // 在任何外部 STT/OSS 调用前执行固定费用门禁；这里只预检，不占款。
    if (billing && tenantId) {
      const allowed = context.runId
        ? await billing.authorizeFixedFee({
            tenantId,
            ...(userId ? { userId } : {}),
            runId: context.runId,
            creditsMicro,
          })
        : await billing.assertTenantCanAffordFixedFee(tenantId, creditsMicro);
      if (!allowed.ok) {
        throw new Error(
          `语音转写请求已拒绝（未扣费）：${allowed.reason} 本次需 ${pricing.creditsPerCall} 积分。`,
        );
      }
      billable = await billing.isTenantBillable(tenantId);
    }

    // 失败（包括取消）不会写计费事件，也不会走直接扣费 fallback。
    let transcribed: SttResult;
    try {
      transcribed = await this.transcribe(
        resolvedInput.value,
        this.options.config.sttConfig,
        {
          speaker: input.speaker,
          timestamps: input.timestamps,
          signal: context.signal,
          onCleanupError: (error) => this.options.logger?.warn?.(
            `AudioTranscribe OSS cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        },
      );
    } finally {
      await resolvedInput.close?.();
    }

    throwIfAborted(context.signal);
    const persisted = await this.persistTranscript(
      transcribed.text,
      safeOriginalStem(input.input, resolvedInput.url),
      context.workspace.root,
    );
    const outputPath = persisted.outputPath;
    try {
      throwIfAborted(context.signal);
    } catch (error) {
      // 取消恰好发生在落盘期间时撤回刚写入的结果，且不进入计费阶段。
      await removeTrustedPath(context.workspace.root, persisted.outputPath).catch(() => undefined);
      throw error;
    }

    const event: PlatformEventInput = {
      type: 'metered_tool_usage',
      runId: context.runId ?? '',
      sessionId: context.sessionId ?? context.workspace.sessionId ?? '',
      toolId: audioTranscribeToolDescriptor.id,
      sku: `audio_transcribe:${this.options.config.sttConfig.model || DEFAULT_STT_MODEL}`,
      quantity: 1,
      // 固化调用时的计费状态，避免事件投影前策略变化把“本次不扣费”重新解释为扣费。
      unitCreditsMicro: billable ? creditsMicro : 0,
      unitCostYuanMicro: costYuanMicro,
      billingChargeKey: chargeKey,
      note: `durationMs=${transcribed.duration} speaker=${input.speaker === true} timestamps=${input.timestamps === true}`,
    };

    if (this.options.appendPlatformEvent) {
      try {
        await this.options.appendPlatformEvent(event, tenantId ? { tenantId } : undefined);
      } catch (error) {
        if (!billing || !tenantId || !billable) throw error;
        this.options.logger?.warn?.(
          `metered_tool_usage append failed; charging audio directly: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.chargeDirectly(billing, tenantId, context, chargeKey, creditsMicro, costYuanMicro);
      }
    } else if (billing && tenantId && billable) {
      await this.chargeDirectly(billing, tenantId, context, chargeKey, creditsMicro, costYuanMicro);
    }

    const model = this.options.config.sttConfig.model || DEFAULT_STT_MODEL;
    const textTruncated = transcribed.text.length > MAX_INLINE_TRANSCRIPT_CHARS;
    const payload = {
      text: textTruncated
        ? `${transcribed.text.slice(0, MAX_INLINE_TRANSCRIPT_CHARS)}\n\n[工具结果已截断，完整转写见 ${outputPath}]`
        : transcribed.text,
      textTruncated,
      characterCount: transcribed.text.length,
      outputPath,
      durationMs: transcribed.duration,
      model,
      creditsCharged: billable ? pricing.creditsPerCall : 0,
      ...(billable
        ? { pricingNote: `${pricing.creditsPerCall} 积分/次` }
        : { billingNote: '该组织未启用积分计费（内部/未开计费租户），本次未扣积分' }),
      deliveryInstruction: `转写结果已写入 ${outputPath}。最终回复必须原样使用并明确告知用户这个返回路径，不要声称写入其他路径。`,
    };
    return {
      content: JSON.stringify(payload, null, 2),
      presentation: {
        title: '语音转文字',
        status: 'ok',
        detail: [
          { k: '输出', v: outputPath },
          { tree: '├', k: '模型', v: model },
          { tree: '├', k: '时长', v: `${transcribed.duration} ms` },
          billable
            ? { tree: '└', k: '积分', v: `${pricing.creditsPerCall}（${pricing.creditsPerCall} 积分/次）` }
            : { tree: '└', k: '计费', v: '内部/未开计费租户，本次未扣积分' },
        ],
      },
    };
  }

  private async resolveInput(
    input: string,
    workspaceRoot: string,
  ): Promise<{ value: string; url?: URL; close?: () => Promise<void> }> {
    const url = parseHttpUrl(input);
    if (url) return { value: url.toString(), url };
    if (
      isAbsolute(input)
      || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)
      || input.split(/[\\/]+/).includes('..')
    ) {
      throw new Error(`转写输入路径越界：${input}（只允许工作区内相对路径或 http/https URL）`);
    }

    let opened;
    try {
      opened = await openTrustedFile(workspaceRoot, input);
    } catch {
      throw new Error(`转写输入路径越界：symlink 不允许且可能指向工作区外，或文件不存在：${input}`);
    }
    return {
      value: opened.fdPath,
      close: async () => { await opened.handle.close(); },
    };
  }

  private async persistTranscript(
    text: string,
    originalStem: string,
    workspaceRoot: string,
  ): Promise<{ outputPath: string }> {
    const relativeDir = posix.join('assets', dateDirectory());
    const fileName = `${originalStem}-转写-${randomUUID().slice(0, 8)}.txt`;
    const outputPath = posix.join(relativeDir, fileName);
    try {
      await writeTrustedFile(workspaceRoot, outputPath, text, {
        encoding: 'utf8',
        createParents: true,
        exclusive: true,
      });
    } catch (error) {
      throw new Error(`转写输出目录越界或不可写：${error instanceof Error ? error.message : String(error)}`);
    }
    return { outputPath };
  }

  private async chargeDirectly(
    billing: BillingService,
    tenantId: string,
    context: ToolCallContext,
    chargeKey: string,
    creditsMicro: number,
    costYuanMicro: number,
  ): Promise<void> {
    await billing.chargeFixedDebit({
      tenantId,
      ...(context.channelContext.user?.id ? { userId: context.channelContext.user.id } : {}),
      ...(context.channelContext.user?.username ? { username: context.channelContext.user.username } : {}),
      idempotencyKey: chargeKey,
      source: 'tool:audio_transcribe',
      creditsMicro,
      actualCostYuanMicro: costYuanMicro,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
      note: `AudioTranscribe ${this.options.config.sttConfig.model || DEFAULT_STT_MODEL}`,
    });
  }
}

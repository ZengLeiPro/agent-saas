import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { isToolEnabled } from '../agent/toolRuntime.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, ImageGenPricingConfig } from '../app/config.js';
import {
  DEFAULT_IMAGE_GEN_PRICING,
  listEffectiveImageGenPricing,
} from '../data/usage/imageGenPricing.js';

/**
 * GenerateImage per-engine 生图定价平台管理 API（2026-07-15 批次）。
 *
 * 模式完全照抄 modelsAdmin.ts（07-14「/compact 压缩窗口逐模型配置」同款）：
 *   - 持久化载体 = config.json `imageGenTools.pricing`，jsonc modify/applyEdits
 *     局部回写（保留注释与其余内容）；
 *   - 校验 = body 合并进 raw config 后整份 parseAppConfig zod 校验（非法值 400，
 *     错误信息带字段路径）；
 *   - 即时生效 = 同步更新进程内 config 对象 + onPricingUpdated 回调重建
 *     imageGenPricing 注册表，扣费点每次现查 getter。
 */
export interface CreateImageGenPricingAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  onPricingUpdated?: (pricing: ImageGenPricingConfig | undefined) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validatePricingUpdate(currentRaw: unknown, pricingBody: unknown): AppConfig['imageGenTools'] {
  const rawRecord = isRecord(currentRaw) ? currentRaw : {};
  const currentImageGenTools = isRecord(rawRecord.imageGenTools) ? rawRecord.imageGenTools : {};
  const merged: Record<string, unknown> = {
    ...rawRecord,
    imageGenTools: {
      ...currentImageGenTools,
      pricing: pricingBody ?? undefined,
    },
  };
  const parsed = parseAppConfig(merged);
  return parsed.imageGenTools;
}

function pricingView(config: AppConfig) {
  const imageGenTools = config.imageGenTools;
  const configuredEngines: string[] = [];
  const gptImage2 = imageGenTools?.gptImage2;
  if (gptImage2 && gptImage2.enabled !== false && gptImage2.baseUrl && (gptImage2.apiKey || gptImage2.apiKeyRef)) {
    configuredEngines.push('gpt-image-2');
  }
  const seedream = imageGenTools?.seedream;
  if (seedream && seedream.enabled !== false && (seedream.apiKey || seedream.apiKeyRef)) {
    configuredEngines.push('seedream');
  }
  const platformEnabled = !!imageGenTools && imageGenTools.enabled !== false;
  const toolEnabled = isToolEnabled(config.toolControls, 'GenerateImage');
  return {
    // 生效视图：配置覆盖合并到内置默认（扣费实际使用的表）
    pricing: listEffectiveImageGenPricing(),
    // 管理员显式配置（null = 全部走内置默认）
    configured: config.imageGenTools?.pricing ?? null,
    defaults: DEFAULT_IMAGE_GEN_PRICING,
    status: {
      available: platformEnabled && toolEnabled && configuredEngines.length > 0,
      platformEnabled,
      toolEnabled,
      configuredEngines,
    },
  };
}

export function createImageGenPricingAdminRouter(options: CreateImageGenPricingAdminRouterOptions): Router {
  const router = Router();

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json(pricingView(options.config));
  });

  router.put('/', (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let rawConfig: unknown;
    let nextImageGenTools: AppConfig['imageGenTools'];

    try {
      configText = readFileSync(configPath, 'utf-8');
      rawConfig = parseJsonc(configText);
      nextImageGenTools = validatePricingUpdate(rawConfig, req.body?.pricing);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const rawRecord = isRecord(rawConfig) ? rawConfig : {};
      const hasImageGenToolsObject = isRecord(rawRecord.imageGenTools);
      const nextPricing = nextImageGenTools?.pricing;
      // 父节点缺失时不能直接 modify 嵌套路径（jsonc-parser 不会创建中间对象）——
      // 与 modelsAdmin.ts 的 memory.index 写法一致。
      const edits = hasImageGenToolsObject
        ? modify(configText, ['imageGenTools', 'pricing'], nextPricing, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          })
        : nextPricing
          ? modify(configText, ['imageGenTools'], { pricing: nextPricing }, {
              formattingOptions: { insertSpaces: true, tabSize: 2 },
            })
          : [];
      const updatedText = edits.length > 0 ? applyEdits(configText, edits) : configText;
      writeFileSync(configPath, updatedText, 'utf-8');
      options.config.imageGenTools = nextImageGenTools;
      options.onPricingUpdated?.(nextImageGenTools?.pricing);
      res.json(pricingView(options.config));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

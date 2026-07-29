import { readFileSync, writeFileSync } from 'node:fs';

import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, CodexSubscriptionConfig } from '../app/config.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';

export interface CreateCodexSubscriptionAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  credentialManager: CodexCredentialManager;
  deviceAuthService: CodexDeviceAuthService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function persistConfig(
  options: CreateCodexSubscriptionAdminRouterOptions,
  next: CodexSubscriptionConfig,
): CodexSubscriptionConfig {
  const configPath = getAppConfigPath(options.processCwd);
  const configText = readFileSync(configPath, 'utf-8');
  const raw = parseJsonc(configText);
  if (!isRecord(raw)) throw new Error('config.json 根节点必须是对象');

  const parsed = parseAppConfig({ ...raw, codexSubscription: next });
  if (!parsed.codexSubscription) throw new Error('codexSubscription 配置无效');

  const updatedText = applyEdits(
    configText,
    modify(configText, ['codexSubscription'], parsed.codexSubscription, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  writeFileSync(configPath, updatedText, 'utf-8');
  options.config.codexSubscription = parsed.codexSubscription;
  return parsed.codexSubscription;
}

async function publicState(options: CreateCodexSubscriptionAdminRouterOptions) {
  const configuration = options.credentialManager.getConfiguration();
  return {
    config: {
      enabled: configuration.enabled,
      endpoint: configuration.endpoint,
      originator: configuration.originator,
    },
    credential: await options.credentialManager.getStatus(),
    runtime: options.credentialManager.getRuntimeStatus(),
  };
}

export function createCodexSubscriptionAdminRouter(
  options: CreateCodexSubscriptionAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', async (_req, res) => {
    res.json(await publicState(options));
  });

  router.put('/', async (req, res) => {
    const current = options.credentialManager.getConfiguration();
    const body = isRecord(req.body) ? req.body : {};
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled;
    if (enabled && !current.credentialRef) {
      res.status(409).json({ error: '请先完成 Codex 账号授权，再启用订阅 transport' });
      return;
    }

    try {
      persistConfig(options, {
        enabled,
        endpoint: current.endpoint,
        originator: current.originator,
        ...(current.credentialRef ? { credentialRef: current.credentialRef } : {}),
      });
      res.json(await publicState(options));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/device/start', async (_req, res) => {
    try {
      const session = await options.deviceAuthService.start();
      res.status(201).json(session);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/device/:sessionId', async (req, res) => {
    try {
      const result = await options.deviceAuthService.poll(req.params.sessionId);
      if (result.status === 'pending') {
        res.json(result);
        return;
      }
      if (result.status === 'expired') {
        res.status(410).json(result);
        return;
      }

      const current = options.credentialManager.getConfiguration();
      const persisted = await options.credentialManager.persistLogin(
        result.tokens,
        current.credentialRef,
      );
      try {
        persistConfig(options, {
          enabled: true,
          endpoint: current.endpoint,
          originator: current.originator,
          credentialRef: persisted.credentialRef,
        });
      } catch (error) {
        if (!current.credentialRef) {
          await options.credentialManager.revoke(persisted.credentialRef).catch(() => undefined);
        }
        throw error;
      }
      options.deviceAuthService.complete(req.params.sessionId);
      res.json({ status: 'completed', ...(await publicState(options)) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/', async (_req, res) => {
    const current = options.credentialManager.getConfiguration();
    try {
      persistConfig(options, {
        enabled: false,
        endpoint: current.endpoint,
        originator: current.originator,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let cleanupWarning: string | undefined;
    if (current.credentialRef) {
      try {
        const result = await options.credentialManager.revoke(current.credentialRef);
        cleanupWarning = result.remoteWarning;
      } catch {
        cleanupWarning = 'transport 已禁用，但旧 SecretVault 凭据清理失败，请检查凭据存储';
      }
    }
    res.json({
      ...(await publicState(options)),
      ...(cleanupWarning ? { warning: cleanupWarning } : {}),
    });
  });

  return router;
}

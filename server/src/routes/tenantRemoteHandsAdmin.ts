import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, TenantRemoteHandsConfig } from '../app/config.js';
import { DEFAULT_CODING_HAND_NETWORK_POLICY } from '../runtime/networkPolicy.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { SecretVault } from '../security/secretVault.js';

export interface CreateTenantRemoteHandsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  onTenantRemoteHandsUpdated?: (tenantRemoteHands: TenantRemoteHandsConfig) => void;
}

type RawObject = Record<string, unknown>;

function readRawConfig(configPath: string): unknown {
  return parseJsonc(readFileSync(configPath, 'utf-8'));
}

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function currentTenantRemoteHands(rawConfig: unknown): RawObject[] {
  if (!isObject(rawConfig)) return [];
  const tenantRemoteHands = rawConfig.tenantRemoteHands;
  if (!isObject(tenantRemoteHands)) return [];
  const hands = tenantRemoteHands.hands;
  return Array.isArray(hands) ? hands.filter(isObject) : [];
}

function stripAdminOnlyFields(hand: RawObject): RawObject {
  const next = { ...hand };
  delete next.authTokenConfigured;
  delete next.preserveAuth;
  if (next.authToken === '') delete next.authToken;
  if (next.authTokenRef === '') delete next.authTokenRef;
  return next;
}

function hydratePreservedCredentials(rawConfig: unknown, tenantRemoteHands: unknown): unknown {
  if (!isObject(tenantRemoteHands)) return tenantRemoteHands;
  const hands = Array.isArray(tenantRemoteHands.hands) ? tenantRemoteHands.hands : [];
  const existingById = new Map<string, RawObject>();
  for (const hand of currentTenantRemoteHands(rawConfig)) {
    if (typeof hand.id === 'string') existingById.set(hand.id, hand);
  }
  return {
    ...tenantRemoteHands,
    hands: hands.map((rawHand) => {
      if (!isObject(rawHand)) return rawHand;
      const hand = stripAdminOnlyFields(rawHand);
      const hasInline = typeof hand.authToken === 'string' && hand.authToken.length > 0;
      const hasRef = typeof hand.authTokenRef === 'string' && hand.authTokenRef.length > 0;
      if (hasInline || hasRef || typeof hand.id !== 'string') return hand;
      const existing = existingById.get(hand.id);
      if (typeof existing?.authToken === 'string' && existing.authToken.length > 0) {
        return { ...hand, authToken: existing.authToken };
      }
      if (typeof existing?.authTokenRef === 'string' && existing.authTokenRef.length > 0) {
        return { ...hand, authTokenRef: existing.authTokenRef };
      }
      return hand;
    }),
  };
}

export function sanitizeTenantRemoteHands(config: TenantRemoteHandsConfig | undefined) {
  return {
    hands: (config?.hands ?? []).map((hand) => {
      const { authToken: _authToken, ...safe } = hand;
      return {
        ...safe,
        authTokenConfigured: typeof hand.authToken === 'string' && hand.authToken.length > 0,
      };
    }),
  };
}

function validateTenantRemoteHandsUpdate(
  currentRaw: unknown,
  tenantRemoteHands: unknown,
): TenantRemoteHandsConfig {
  const hydrated = hydratePreservedCredentials(currentRaw, tenantRemoteHands);
  const merged = {
    ...(isObject(currentRaw) ? currentRaw : {}),
    tenantRemoteHands: hydrated,
  };
  return parseAppConfig(merged).tenantRemoteHands ?? { hands: [] };
}

function isDefaultNetworkPolicy(policy: TenantRemoteHandsConfig['hands'][number]['networkPolicy']): boolean {
  if (!policy) return true;
  return policy.mode === DEFAULT_CODING_HAND_NETWORK_POLICY.mode
    && policy.denyPrivateNetworks === DEFAULT_CODING_HAND_NETWORK_POLICY.denyPrivateNetworks
    && (policy.allowCidrs?.length ?? 0) === 0
    && (policy.allowDomains?.length ?? 0) === 0
    && (policy.denyCidrs?.length ?? 0) === 0;
}

function serializeTenantRemoteHandsConfig(config: TenantRemoteHandsConfig): unknown {
  return {
    hands: config.hands.map((hand) => {
      if (!isDefaultNetworkPolicy(hand.networkPolicy)) return hand;
      const { networkPolicy: _networkPolicy, ...rest } = hand;
      return rest;
    }),
  };
}

export async function probeTenantRemoteHandHealth(args: {
  hand: TenantRemoteHandsConfig['hands'][number];
  vault?: SecretVault;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ status: 'ok' | 'unhealthy'; detail?: string; metadata?: unknown }> {
  let authToken: string;
  try {
    const resolver = createTenantRemoteHandAuthTokenResolver({
      tenantRemoteHands: [args.hand],
      vault: args.vault,
    });
    const resolved = await resolver.resolveForRegister(args.hand);
    authToken = resolved.authToken;
  } catch (error) {
    return {
      status: 'unhealthy',
      detail: `auth_resolve_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  timer.unref?.();
  try {
    const response = await args.fetchImpl(`${args.hand.baseUrl.replace(/\/$/, '')}/health`, {
      headers: { authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      return { status: 'unhealthy', detail: `HTTP ${response.status}`, metadata: body };
    }
    return {
      status: isObject(body) && body.status === 'ok' ? 'ok' : 'unhealthy',
      metadata: body,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      detail: controller.signal.aborted ? `health timeout (${args.timeoutMs}ms)` : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createTenantRemoteHandsAdminRouter(
  options: CreateTenantRemoteHandsAdminRouterOptions,
): Router {
  const router = Router();
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000;

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json({
      tenantRemoteHands: sanitizeTenantRemoteHands(options.config.tenantRemoteHands),
    });
  });

  router.put('/', (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let rawConfig: unknown;
    let nextTenantRemoteHands: TenantRemoteHandsConfig;

    try {
      configText = readFileSync(configPath, 'utf-8');
      rawConfig = parseJsonc(configText);
      if (!isObject(req.body?.tenantRemoteHands)) {
        res.status(400).json({ error: 'tenantRemoteHands object is required' });
        return;
      }
      nextTenantRemoteHands = validateTenantRemoteHandsUpdate(rawConfig, req.body?.tenantRemoteHands);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    try {
      const edits = modify(configText, ['tenantRemoteHands'], serializeTenantRemoteHandsConfig(nextTenantRemoteHands), {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updatedText = applyEdits(configText, edits);
      writeFileSync(configPath, updatedText, 'utf-8');
      options.config.tenantRemoteHands = nextTenantRemoteHands;
      options.onTenantRemoteHandsUpdated?.(nextTenantRemoteHands);
      res.json({
        tenantRemoteHands: sanitizeTenantRemoteHands(nextTenantRemoteHands),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/:id/health', async (req, res) => {
    const hand = options.config.tenantRemoteHands?.hands.find((candidate) => candidate.id === req.params.id);
    if (!hand) {
      res.status(404).json({ error: 'tenant remote hand not found' });
      return;
    }
    const result = await probeTenantRemoteHandHealth({
      hand,
      vault: options.secretVault,
      fetchImpl,
      timeoutMs: healthTimeoutMs,
    });
    res.json({ id: hand.id, ...result });
  });

  return router;
}

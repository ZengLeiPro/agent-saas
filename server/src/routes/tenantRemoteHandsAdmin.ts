
import { Router } from 'express';
import { applyEdits, modify } from 'jsonc-parser';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, TenantRemoteHandsConfig } from '../app/config.js';
import { DEFAULT_CODING_HAND_NETWORK_POLICY } from '../runtime/networkPolicy.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { SecretVault } from '../security/secretVault.js';
import { GLOBAL_OWNER_ID } from '../security/secretVault.js';
import { AdminConfigMutationService } from '../config/adminConfigMutationService.js';
import { adminConfigReadMetadata, mutationRequestContext, sendConfigMutationError } from '../config/adminConfigMutationHttp.js';
import { readRuntimeIdentity } from '../release/runtimeIdentity.js';
import { RouteSecretRefMutation } from './secretRefMutation.js';

const TENANT_HAND_SECRET_WRITER = {
  actor: 'system' as const,
  userId: '__system__',
  scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:revoke'],
};
const TENANT_HAND_SECRET_INSPECTOR = {
  actor: 'system' as const,
  userId: '__system__',
  scopes: ['secret:metadata:read'],
};

export interface CreateTenantRemoteHandsAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  onTenantRemoteHandsUpdated?: (tenantRemoteHands: TenantRemoteHandsConfig) => void;
  validateConfigReload?: (next: AppConfig) => void | Promise<void>;
  configMutationService?: AdminConfigMutationService;
}

/** JSON 配置对象的窄类型。 */
type RawObject = Record<string, unknown>;

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
      const { authToken: _authToken, authTokenRef: _authTokenRef, ...safe } = hand;
      return {
        ...safe,
        authTokenConfigured: Boolean(hand.authToken || hand.authTokenRef),
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
  const configMutationService = options.configMutationService ?? new AdminConfigMutationService({
    configPath: getAppConfigPath(options.processCwd),
    processCwd: options.processCwd,
    environment: readRuntimeIdentity().environment,
    processRole: 'all',
  });

  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...adminConfigReadMetadata(options.processCwd, configMutationService),
      tenantRemoteHands: sanitizeTenantRemoteHands(options.config.tenantRemoteHands),
    });
  });

  router.put('/', async (req, res) => {
    if (!isObject(req.body?.tenantRemoteHands)) {
      res.status(400).json({ error: 'tenantRemoteHands object is required' });
      return;
    }
    let staged: TenantRemoteHandsConfig | undefined;
    const secretMutation = new RouteSecretRefMutation(
      options.secretVault,
      TENANT_HAND_SECRET_WRITER,
      { preservePreviousOnCommit: configMutationService.isControlledProductionPublisher() },
    );
    try {
      const requestContext = mutationRequestContext(req);
      secretMutation.bindOperation(requestContext.operationId);
      const result = await configMutationService.mutate({
        ...requestContext,
        operation: { id: 'tenant-remote-hands.save' },
        changedPaths: ['tenantRemoteHands'],
        buildCandidate: async (configText, rawConfig) => {
          const current = parseAppConfig(rawConfig).tenantRemoteHands;
          secretMutation.trackPrevious(current?.hands.map((hand) => hand.authTokenRef) ?? []);
          const requested: TenantRemoteHandsConfig = validateTenantRemoteHandsUpdate(rawConfig, req.body.tenantRemoteHands);
          const currentRefById = new Map(
            (current?.hands ?? []).map((hand) => [hand.id, hand.authTokenRef] as const),
          );
          for (const hand of requested.hands) {
            if (!hand.authTokenRef || hand.authTokenRef === currentRefById.get(hand.id)) continue;
            if (!options.secretVault?.inspectRef) {
              throw new Error(`tenantRemoteHands ${hand.id} 的新 authTokenRef 无法验证`);
            }
            const ref = await options.secretVault.inspectRef(hand.authTokenRef, TENANT_HAND_SECRET_INSPECTOR);
            if (
              !ref
              || ref.revokedAt
              || ref.ownerId !== GLOBAL_OWNER_ID
              || ref.kind !== 'tenant-hand'
              || ref.metadata.handId !== hand.id
            ) {
              throw new Error(`tenantRemoteHands ${hand.id} 的 authTokenRef 不属于该执行环境`);
            }
          }
          const submittedInlineIds = new Set<string>(
            (Array.isArray(req.body.tenantRemoteHands.hands) ? req.body.tenantRemoteHands.hands : [])
              .filter(isObject)
              .filter((hand: RawObject) => typeof hand.authToken === 'string' && hand.authToken.length > 0)
              .map((hand: RawObject) => hand.id)
              .filter((id: unknown): id is string => typeof id === 'string'),
          );
          if (!secretMutation.available && submittedInlineIds.size > 0 && options.validateConfigReload) {
            await options.validateConfigReload(parseAppConfig({ ...rawConfig, tenantRemoteHands: requested }));
          }
          staged = {
            hands: await Promise.all(requested.hands.map(async (hand) => {
              if (!hand.authToken || !submittedInlineIds.has(hand.id)) return hand;
              const { authToken, ...safe } = hand;
              const authTokenRef = await secretMutation.put(
                GLOBAL_OWNER_ID,
                'tenant-hand',
                authToken,
                { handId: hand.id, purpose: 'tenant-remote-hand' },
              );
              return { ...safe, authTokenRef };
            })),
          };
          const parsed = parseAppConfig({ ...rawConfig, tenantRemoteHands: staged });
          staged = parsed.tenantRemoteHands ?? { hands: [] };
          return applyEdits(configText, modify(configText, ['tenantRemoteHands'], serializeTenantRemoteHandsConfig(staged), {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }));
        },
        ...(options.validateConfigReload ? { validateCandidate: options.validateConfigReload } : {}),
        applyRuntime: (candidate) => {
          const next = candidate.tenantRemoteHands ?? { hands: [] };
          options.config.tenantRemoteHands = next;
          options.onTenantRemoteHandsUpdated?.(next);
        },
        onCommitted: async () => {
          await secretMutation.committed(staged?.hands.map((hand) => hand.authTokenRef) ?? []);
        },
      });

      res.json({
        ...adminConfigReadMetadata(options.processCwd, configMutationService),
        tenantRemoteHands: sanitizeTenantRemoteHands(result.config.tenantRemoteHands),
      });
    } catch (error) {
      await secretMutation.failed(error, staged?.hands.map((hand) => hand.authTokenRef) ?? []);
      if (error instanceof Error && /tenantRemoteHands|hands|baseUrl|authToken|Secret|credential/u.test(error.message)) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendConfigMutationError(res, error);
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

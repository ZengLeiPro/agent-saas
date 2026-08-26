import { join, resolve } from 'path';
import type { AppConfig } from '../types/index.js';
import { serverLogger } from '../utils/logger.js';
import { resolveSttRuntimeConfig } from '../runtime/sttRuntimeConfig.js';
import {
  EncryptedFileSecretVault,
  HttpSecretVault,
  InMemorySecretVault,
  type SecretVault,
} from '../security/secretVault.js';
import type { ResolvedWebToolsConfig } from '../agent/webToolProvider.js';
import type { WebSearchProviderConfig } from '../agent/web/searchProviderTypes.js';
import type { ResolvedImageGenToolsConfig } from '../agent/imageGenToolProvider.js';

/** Resolves startup credentials without exposing plaintext outside server bootstrap objects. */
export async function initializeRuntimeGovernanceCredentials(
  config: AppConfig,
  processCwd: string,
) {
  // A2: SecretVault 提前到 ClientDaemonGateway 之前，便于装配时按 vault ref 解析
  // clientDaemon.authTokenRef → plaintext，再用 setAuthToken 注入。提前到这里也让
  // MCP / tenant resolver / serverRemote 装配时共享同一个 vault 实例。
  const secretVault: SecretVault = (() => {
    const vc = config.secretVault;
    if (!vc) {
      const jwtSecret = config.auth?.jwtSecret;
      if (process.env.NODE_ENV === 'production' && config.runtimeEventStore?.backend === 'pg' && jwtSecret) {
        return new EncryptedFileSecretVault(
          join(processCwd, 'data', 'secrets.enc'),
          `agent-saas/secret-vault/v1:${jwtSecret}`,
        );
      }
      return new InMemorySecretVault();
    }
    if (vc.backend === 'memory') {
      return new InMemorySecretVault();
    }
    if (vc.backend === 'encrypted-file') {
      const key = vc.encryptionKey
        ?? (vc.encryptionKeyEnv ? process.env[vc.encryptionKeyEnv] : undefined);
      if (!key || key.length < 16) {
        throw new Error(
          `secretVault.backend="encrypted-file" 加密密钥未提供或长度 <16：${vc.encryptionKeyEnv ? `env "${vc.encryptionKeyEnv}" 为空或过短` : 'encryptionKey 缺失'}`,
        );
      }
      const filePath = resolve(processCwd, vc.filePath);
      return new EncryptedFileSecretVault(filePath, key);
    }
    // http
    const token = vc.authToken
      ?? (vc.authTokenEnv ? process.env[vc.authTokenEnv] : undefined);
    if (!token || token.length < 8) {
      throw new Error(
        `secretVault.backend="http" bearer token 未提供或长度 <8：${vc.authTokenEnv ? `env "${vc.authTokenEnv}" 为空或过短` : 'authToken 缺失'}`,
      );
    }
    return new HttpSecretVault({ baseUrl: vc.baseUrl, authToken: token });
  })();
  const resolvedSttRuntimeConfig = await resolveSttRuntimeConfig(config.stt, secretVault);

  // A5: clientDaemon 的 bearer 在装配阶段解析为 plaintext。`authTokenRef` 走 vault
  // (actor:'system', scope:'secret:client_daemon:read')，`authToken` inline 透传。
  // 两者都未提供时返回 undefined → gateway 接受任意连接（dev/受信网络）。
  const resolvedClientDaemonAuthToken = await (async (): Promise<string | undefined> => {
    const cd = config.clientDaemon;
    if (!cd) return undefined;
    if (cd.authTokenRef) {
      try {
        return await secretVault.getSecret(cd.authTokenRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:client_daemon:read'],
        });
      } catch (err) {
        throw new Error(
          `clientDaemon.authTokenRef "${cd.authTokenRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return cd.authToken;
  })();

  // 飞书 Token Broker 只在 Server 内持有平台 App Secret。用户 access/refresh token
  // 以 tenant/user 隔离写入 SecretVault；sandbox 每次运行只获得 App ID 与短期 access token。
  // inline secret 仅作部署迁移兼容，生产优先使用 SecretVault ref。
  const resolvedFeishuConnector = await (async (): Promise<{ appId: string; appSecret: string } | undefined> => {
    const appId = process.env.FEISHU_CONNECTOR_APP_ID?.trim();
    const appSecretRef = process.env.FEISHU_CONNECTOR_APP_SECRET_REF?.trim();
    const inlineSecret = process.env.FEISHU_CONNECTOR_APP_SECRET?.trim();
    // 迁移期 inline secret 读取后立即从宿主 env 移除，避免匿名内部子进程继承。
    if (inlineSecret) delete process.env.FEISHU_CONNECTOR_APP_SECRET;
    if (!appId && !appSecretRef && !inlineSecret) return undefined;
    if (!appId) {
      serverLogger.warn('Feishu connector disabled: FEISHU_CONNECTOR_APP_ID is missing');
      return undefined;
    }
    try {
      const appSecret = appSecretRef
        ? await secretVault.getSecret(appSecretRef, {
            actor: 'system',
            userId: '__system__',
            scopes: ['secret:feishu_connector:read'],
          })
        : inlineSecret;
      if (!appSecret) {
        serverLogger.warn('Feishu connector disabled: app secret is missing');
        return undefined;
      }
      return { appId, appSecret };
    } catch (err) {
      serverLogger.warn(`Feishu connector disabled: app secret resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();
  const feishuConnectorScopes = Array.from(new Set(
    (process.env.FEISHU_CONNECTOR_SCOPES ?? '')
      .split(/[\s,]+/)
      .map(scope => scope.trim())
      .filter(scope => scope && scope !== 'offline_access'),
  )).join(' ');
  if (resolvedFeishuConnector && !feishuConnectorScopes) {
    serverLogger.warn('Feishu Token Broker disabled: FEISHU_CONNECTOR_SCOPES has no business scopes');
  }

  return {
    secretVault,
    resolvedSttRuntimeConfig,
    resolvedClientDaemonAuthToken,
    resolvedFeishuConnector,
    feishuConnectorScopes,
  };
}

export async function resolveWebToolsConfig(
  webTools: AppConfig['webTools'],
  secretVault: SecretVault,
): Promise<ResolvedWebToolsConfig | undefined> {
  if (!webTools) return undefined;
  const resolved: ResolvedWebToolsConfig = {};
  if (webTools.enabled !== undefined) resolved.enabled = webTools.enabled;
  if (webTools.fetch) resolved.fetch = webTools.fetch;
  if (webTools.egress) resolved.egress = webTools.egress;

  if (webTools.search) {
    const { apiKeyRef, apiKey, global: globalSearch, ...searchRest } = webTools.search;
    const resolvedApiKey = await resolveSearchApiKey(
      { apiKey, apiKeyRef },
      secretVault,
      'webTools.search.apiKeyRef',
    );
    let resolvedGlobal: WebSearchProviderConfig | undefined;
    if (globalSearch) {
      const { apiKeyRef: globalRef, apiKey: globalKey, ...globalRest } = globalSearch;
      const resolvedGlobalKey = await resolveSearchApiKey(
        { apiKey: globalKey, apiKeyRef: globalRef },
        secretVault,
        'webTools.search.global.apiKeyRef',
      );
      resolvedGlobal = {
        ...globalRest,
        ...(resolvedGlobalKey ? { apiKey: resolvedGlobalKey } : {}),
      };
    }
    resolved.search = {
      ...searchRest,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      ...(resolvedGlobal ? { global: resolvedGlobal } : {}),
    };
  }

  return resolved;
}

async function resolveSearchApiKey(
  credential: { apiKey?: string; apiKeyRef?: string },
  secretVault: SecretVault,
  label: string,
): Promise<string | undefined> {
  if (!credential.apiKeyRef) return credential.apiKey;
  try {
    return await secretVault.getSecret(credential.apiKeyRef, {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:web_tools:read'],
    });
  } catch (err) {
    throw new Error(`${label} "${credential.apiKeyRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * GenerateImage 生图工具凭据解析（2026-07-15）：apiKeyRef 经 secretVault 解析成
 * 明文 key 后只进 rawRuntimeConfig（server 进程内），绝不进 sandbox env、绝不加进
 * handEnvAllowlist / tenantSharedEnv——复用 webTools 的 apiKeyRef 先例。
 */
export async function resolveImageGenToolsConfig(
  imageGenTools: AppConfig['imageGenTools'],
  secretVault: SecretVault,
): Promise<ResolvedImageGenToolsConfig | undefined> {
  if (!imageGenTools) return undefined;
  const resolved: ResolvedImageGenToolsConfig = {};
  if (imageGenTools.enabled !== undefined) resolved.enabled = imageGenTools.enabled;

  for (const key of ['gptImage2', 'seedream'] as const) {
    const engine = imageGenTools[key];
    if (!engine) continue;
    const { apiKeyRef, apiKey, ...engineRest } = engine;
    let resolvedApiKey = apiKey;
    if (apiKeyRef) {
      try {
        resolvedApiKey = await secretVault.getSecret(apiKeyRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:image_gen_tools:read'],
        });
      } catch (err) {
        throw new Error(
          `imageGenTools.${key}.apiKeyRef "${apiKeyRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    resolved[key] = {
      ...engineRest,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    };
  }

  return resolved;
}

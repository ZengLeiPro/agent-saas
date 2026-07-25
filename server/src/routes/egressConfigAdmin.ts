/**
 * 平台管理「网络出口」配置 API（2026-07-25）。
 *
 * GET/PUT  /api/admin/egress-config        读取 / 全量保存（requirePlatformAdmin）
 * POST     /api/admin/egress-config/probe  用草稿里的代理地址做连通性探测，不落盘
 *
 * 保存语义：
 *   - server 段落盘即生效（EgressDispatcherRegistry 按 configVersion 懒重建）。
 *   - sandbox / packageMirrors 段除落盘外还会 PATCH 给 acs-orchestrator；
 *     下发失败不回滚配置，只记录 sandboxSync 状态——配置本身已是期望态，
 *     orchestrator 重启或下次保存会重新拉齐。
 *   - Pod env 在容器创建时固化，因此 sandbox 段只对**新建容器**生效，
 *     已运行容器需等自然 pause/重建，这一点在 UI 上有明确提示。
 */

import { Router } from 'express';
import { z } from 'zod';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { requirePlatformAdmin } from '../auth/middleware.js';
import type { AppConfig } from '../app/config.js';
import { egressConfigSchema } from '../app/config.js';
import type { EgressConfigStore } from '../data/egressConfig.js';
import { parseProxyUrl, type EgressConfig } from '../runtime/egressPolicy.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';
import { requestAcsOrchestrator } from './runtimeOperationsAdmin.js';
import { auditLog } from '../data/login-logs/index.js';

const EGRESS_SECRET_KIND = 'egress-proxy';
const DEFAULT_PROBE_TARGET = 'https://www.google.com/generate_204';
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const ORCHESTRATOR_SYNC_TIMEOUT_MS = 15_000;

export interface CreateEgressConfigAdminRouterOptions {
  config: AppConfig;
  store: EgressConfigStore;
  secretVault?: SecretVault;
  /** 保存代理凭据后刷新 dispatcher 的同步缓存 */
  refreshProxyCredential?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  logger?: { warn(msg: string): void; info(msg: string): void };
}

const updateSchema = z.object({
  config: egressConfigSchema,
  /** undefined = 不改动；null = 清除；string = 写入 vault */
  proxyCredential: z.union([z.string().min(1), z.null()]).optional(),
});

const probeSchema = z.object({
  proxyUrl: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  target: z.string().url().optional(),
});

/**
 * 跨字段校验。zod schema 只保证形状，这里保证语义——
 * 启用了却没填地址、或填了 undici 不支持的协议，都必须在保存前拦住。
 */
function validateEgressConfig(config: EgressConfig): string | null {
  if (config.server.enabled) {
    const parsed = parseProxyUrl(config.server.proxyUrl);
    if (!parsed) return 'server 段已启用，但代理地址为空或格式非法';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `server 段仅支持 http/https 代理（当前 ${parsed.protocol}），socks 请改用 sandbox 段`;
    }
  }
  if (config.sandbox.enabled && !parseProxyUrl(config.sandbox.proxyUrl)) {
    return 'sandbox 段已启用，但代理地址为空或格式非法';
  }
  if (config.packageMirrors.enabled) {
    for (const [label, value] of [
      ['pipIndexUrl', config.packageMirrors.pipIndexUrl],
      ['npmRegistry', config.packageMirrors.npmRegistry],
    ] as const) {
      if (!value.trim()) return `镜像源已启用，但 ${label} 为空`;
      try {
        new URL(value);
      } catch {
        return `镜像源 ${label} 不是合法 URL: ${value}`;
      }
    }
  }
  return null;
}

async function probeOnce(args: {
  target: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  proxyUrl?: string;
}): Promise<{ target: string; ok: boolean; status: number | null; latencyMs: number | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  timer.unref?.();
  const startedAt = Date.now();
  let agent: ProxyAgent | undefined;
  try {
    if (args.proxyUrl) {
      const parsed = parseProxyUrl(args.proxyUrl);
      if (!parsed) throw new Error('代理地址格式非法');
      agent = new ProxyAgent({ uri: parsed.sanitizedUrl, connectTimeout: args.timeoutMs });
    }
    // 走代理时必须用 undici 自带 fetch —— 外部 ProxyAgent 交给全局 fetch 会因
    // 两个 undici 实例的内部接口不匹配立即失败，详见 egressDispatcher.ts 注释。
    const response = agent
      ? await undiciFetch(args.target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: agent,
      }) as unknown as Response
      : await args.fetchImpl(args.target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    return {
      target: args.target,
      ok: response.status > 0 && response.status < 500,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    return {
      target: args.target,
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: controller.signal.aborted
        ? `超时（${args.timeoutMs}ms）`
        : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    if (agent) void agent.close().catch(() => undefined);
  }
}

function buildAdminView(store: EgressConfigStore) {
  const sync = store.getSandboxSync();
  const meta = store.getMeta();
  return {
    config: store.getConfig(),
    proxyCredentialConfigured: Boolean(store.getProxyCredentialRef()),
    sandboxSync: {
      ok: sync?.ok ?? false,
      error: sync?.error ?? null,
      syncedAt: sync?.syncedAt ?? null,
    },
    updatedAt: meta.updatedAt ?? null,
    updatedBy: meta.updatedBy ?? null,
  };
}

/** 把 sandbox / packageMirrors 段下发给 acs-orchestrator */
async function syncSandboxToOrchestrator(args: {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl: typeof fetch;
  egress: EgressConfig;
}): Promise<{ ok: boolean; error?: string }> {
  const result = await requestAcsOrchestrator({
    config: args.config,
    secretVault: args.secretVault,
    fetchImpl: args.fetchImpl,
    timeoutMs: ORCHESTRATOR_SYNC_TIMEOUT_MS,
    path: '/runtime-config',
    method: 'PATCH',
    body: {
      egress: {
        proxy: args.egress.sandbox,
        packageMirrors: args.egress.packageMirrors,
      },
    },
  });
  if (result.status >= 200 && result.status < 300) return { ok: true };
  const body = result.body as { error?: string } | undefined;
  return {
    ok: false,
    error: body?.error ? `${result.status}: ${body.error}` : `orchestrator 返回 ${result.status}`,
  };
}

export function createEgressConfigAdminRouter(
  options: CreateEgressConfigAdminRouterOptions,
): Router {
  const fetchImpl = options.fetchImpl ?? fetch;
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json(buildAdminView(options.store));
  });

  router.put('/', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `参数非法: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
      return;
    }
    const nextConfig = parsed.data.config as EgressConfig;
    const semanticError = validateEgressConfig(nextConfig);
    if (semanticError) {
      res.status(400).json({ error: semanticError });
      return;
    }

    // 凭据先写 vault 拿 ref，再连同配置一起落盘——顺序反了会出现
    // 「配置说有凭据但 vault 里没有」的空洞。
    let credentialRef: string | null | undefined;
    if (parsed.data.proxyCredential === null) {
      credentialRef = null;
    } else if (typeof parsed.data.proxyCredential === 'string') {
      if (!options.secretVault) {
        res.status(400).json({ error: 'secretVault 未启用，无法保存代理凭据' });
        return;
      }
      try {
        const ref = await options.secretVault.putSecret(
          GLOBAL_OWNER_ID,
          EGRESS_SECRET_KIND,
          parsed.data.proxyCredential,
          { purpose: 'egress proxy credential' },
        );
        credentialRef = ref.id;
      } catch (err) {
        res.status(500).json({
          error: `代理凭据写入失败: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    try {
      await options.store.update(nextConfig, {
        actor: req.user?.username ?? 'unknown',
        ...(credentialRef === undefined ? {} : { proxyCredentialRef: credentialRef }),
      });
    } catch (err) {
      res.status(500).json({
        error: `配置保存失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    await options.refreshProxyCredential?.().catch(() => undefined);

    // 下发 orchestrator：失败只记录不回滚，配置已是期望态
    const sync = await syncSandboxToOrchestrator({
      config: options.config,
      secretVault: options.secretVault,
      fetchImpl,
      egress: nextConfig,
    });
    await options.store.recordSandboxSync(sync).catch(() => undefined);
    if (!sync.ok) {
      options.logger?.warn(`[egress] sandbox 段下发 orchestrator 失败: ${sync.error}`);
    }

    auditLog(
      req,
      'egress_config_updated',
      `server代理=${nextConfig.server.enabled ? '开' : '关'}`
        + ` sandbox代理=${nextConfig.sandbox.enabled ? '开' : '关'}`
        + ` 镜像源=${nextConfig.packageMirrors.enabled ? '开' : '关'}`
        + ` 下发orchestrator=${sync.ok ? '成功' : `失败(${sync.error ?? 'unknown'})`}`,
    );

    res.json(buildAdminView(options.store));
  });

  router.post('/probe', async (req, res) => {
    const parsed = probeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `参数非法: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
      return;
    }
    if (!parseProxyUrl(parsed.data.proxyUrl)) {
      res.status(400).json({ error: '代理地址格式非法' });
      return;
    }
    const target = parsed.data.target ?? DEFAULT_PROBE_TARGET;
    const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    // 两条并行：经代理 + 直连。直连结果用来说明代理是否真的改变了可达性
    const [viaProxy, direct] = await Promise.all([
      probeOnce({ target, timeoutMs, fetchImpl, proxyUrl: parsed.data.proxyUrl }),
      probeOnce({ target, timeoutMs, fetchImpl }),
    ]);
    res.json({ viaProxy, direct });
  });

  return router;
}

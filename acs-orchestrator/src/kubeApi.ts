import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';

import type { AcsOrchestratorConfig } from './config.js';

/**
 * 2026-08-03 CPU 治理 P3b：高频只读 K8s 查询直连 API server，替代 kubectl
 * shell-out（每次 fork 一个 Go 二进制 + 冷 TLS 握手，是生产 ECS 约一核 CPU
 * 的主要构成之一）。
 *
 * 设计边界：
 * - 只覆盖只读/轻量查询（get CRD / get namespace / SelfSubjectAccessReview /
 *   list Sandbox / list Pod）。exec、apply、delete、wait 等继续走 kubectl——
 *   它们低频且语义复杂，shell-out 成本可以接受。
 * - fail-open 回退：kubeconfig 解析失败时 `tryCreate` 返回 null；单次请求
 *   失败时方法返回 null/undefined，调用方一律回退原 kubectl 路径。行为最坏
 *   等于改造前，不会因为 REST 层问题让 orchestrator 变得更脆。
 * - kubeconfig 支持 token 与 client-cert 两种认证（生产 ACS 最小 RBAC
 *   kubeconfig 实测为 token + certificate-authority-data）。解析器是面向
 *   单 cluster/单 user kubeconfig 的最小实现，出现多个候选值时视为歧义、
 *   整体放弃（返回 null 回退 kubectl），不猜。
 */

export interface KubeApiLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

interface KubeCredentials {
  server: string;
  ca?: Buffer;
  token?: string;
  clientCert?: Buffer;
  clientKey?: Buffer;
  insecureSkipTlsVerify: boolean;
}

interface KubeRequestResult {
  status: number;
  body: unknown;
}

/** 从 CRD 全名（`plural.group.tld`）拆出 plural 与 group。 */
export function splitCrdName(crdName: string): { plural: string; group: string } | null {
  const firstDot = crdName.indexOf('.');
  if (firstDot <= 0 || firstDot === crdName.length - 1) return null;
  return { plural: crdName.slice(0, firstDot), group: crdName.slice(firstDot + 1) };
}

/**
 * 最小 kubeconfig 解析：逐行提取唯一的 server / 认证材料字段。
 * 同名字段出现多次（多 cluster / 多 user）→ 返回 null（歧义不猜）。
 */
export function parseKubeconfig(content: string): KubeCredentials | null {
  const pick = (re: RegExp): string | null | undefined => {
    const matches = [...content.matchAll(re)].map((m) => m[1]!.trim());
    if (matches.length === 0) return undefined;
    if (new Set(matches).size > 1) return null;
    return matches[0];
  };
  const server = pick(/^\s*server:\s*(\S+)\s*$/gm);
  if (!server || !/^https:\/\//.test(server)) return null;
  const caData = pick(/^\s*certificate-authority-data:\s*(\S+)\s*$/gm);
  const token = pick(/^\s*token:\s*(\S+)\s*$/gm);
  const certData = pick(/^\s*client-certificate-data:\s*(\S+)\s*$/gm);
  const keyData = pick(/^\s*client-key-data:\s*(\S+)\s*$/gm);
  const skipVerify = /^\s*insecure-skip-tls-verify:\s*true\s*$/m.test(content);
  if (caData === null || token === null || certData === null || keyData === null) return null;
  const cleanToken = token?.replace(/^["']|["']$/g, '');
  if (!cleanToken && !(certData && keyData)) return null;
  try {
    return {
      server: server.replace(/\/+$/, ''),
      ...(caData ? { ca: Buffer.from(caData, 'base64') } : {}),
      ...(cleanToken ? { token: cleanToken } : {}),
      ...(certData ? { clientCert: Buffer.from(certData, 'base64') } : {}),
      ...(keyData ? { clientKey: Buffer.from(keyData, 'base64') } : {}),
      insecureSkipTlsVerify: skipVerify,
    };
  } catch {
    return null;
  }
}

export class KubeApi {
  private readonly agent: Agent;
  private warnedOnce = false;

  private constructor(
    private readonly creds: KubeCredentials,
    private readonly config: AcsOrchestratorConfig,
    private readonly logger: KubeApiLogger,
  ) {
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 4,
      keepAliveMsecs: 30_000,
      ...(creds.ca ? { ca: creds.ca } : {}),
      ...(creds.clientCert ? { cert: creds.clientCert } : {}),
      ...(creds.clientKey ? { key: creds.clientKey } : {}),
      ...(creds.insecureSkipTlsVerify ? { rejectUnauthorized: false } : {}),
    });
  }

  static tryCreate(config: AcsOrchestratorConfig, logger: KubeApiLogger): KubeApi | null {
    if (!config.kubeconfig) {
      // 无 kubeconfig（in-cluster 或依赖默认路径）——不猜，保持 kubectl 路径。
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(config.kubeconfig, 'utf-8');
    } catch (err) {
      logger.warn(`kube_api_disabled reason=kubeconfig_unreadable err=${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const creds = parseKubeconfig(raw);
    if (!creds) {
      logger.warn('kube_api_disabled reason=kubeconfig_parse_ambiguous_or_unsupported fallback=kubectl');
      return null;
    }
    logger.info(`kube_api_enabled server=${creds.server} auth=${creds.token ? 'token' : 'client-cert'}`);
    return new KubeApi(creds, config, logger);
  }

  /** CRD 存在性检查。失败（网络/解析）→ null，调用方回退 kubectl。 */
  async crdExists(crdName: string): Promise<boolean | null> {
    const result = await this.requestJson('GET', `/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(crdName)}`);
    if (!result) return null;
    if (result.status === 200) return true;
    if (result.status === 404) return false;
    return null;
  }

  async namespaceExists(namespace: string): Promise<boolean | null> {
    const result = await this.requestJson('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}`);
    if (!result) return null;
    if (result.status === 200) return true;
    if (result.status === 404) return false;
    return null;
  }

  /** `kubectl auth can-i create <plural.group>` 的 REST 等价（SelfSubjectAccessReview）。 */
  async canCreate(crdName: string): Promise<boolean | null> {
    const parts = splitCrdName(crdName);
    if (!parts) return null;
    const result = await this.requestJson('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          namespace: this.config.namespace,
          verb: 'create',
          group: parts.group,
          resource: parts.plural,
        },
      },
    });
    if (!result || (result.status !== 200 && result.status !== 201)) return null;
    const status = (result.body as { status?: { allowed?: boolean } } | undefined)?.status;
    return typeof status?.allowed === 'boolean' ? status.allowed : null;
  }

  /**
   * list 受管 Sandbox（`kubectl get sandbox -l ... -o json` 的 REST 等价）。
   * 返回 items 数组；失败 → null 回退 kubectl。
   */
  async listSandboxItems(labelSelector: string): Promise<Array<Record<string, unknown>> | null> {
    const [group, version] = this.config.sandboxApiVersion.split('/');
    if (!group || !version) return null;
    const plural = this.config.sandboxKind.toLowerCase().endsWith('s')
      ? this.config.sandboxKind.toLowerCase()
      : `${this.config.sandboxKind.toLowerCase()}es`;
    const path = `/apis/${group}/${version}/namespaces/${encodeURIComponent(this.config.namespace)}/${plural}`
      + `?labelSelector=${encodeURIComponent(labelSelector)}`;
    const result = await this.requestJson('GET', path);
    if (!result || result.status !== 200) return null;
    const items = (result.body as { items?: unknown } | undefined)?.items;
    return Array.isArray(items) ? items as Array<Record<string, unknown>> : null;
  }

  /** list Pod（`kubectl get pod -l ... -o json` 的 REST 等价）。失败 → null。 */
  async listPodItems(labelSelector: string): Promise<Array<Record<string, unknown>> | null> {
    const path = `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/pods`
      + `?labelSelector=${encodeURIComponent(labelSelector)}`;
    const result = await this.requestJson('GET', path);
    if (!result || result.status !== 200) return null;
    const items = (result.body as { items?: unknown } | undefined)?.items;
    return Array.isArray(items) ? items as Array<Record<string, unknown>> : null;
  }

  private requestJson(method: 'GET' | 'POST', path: string, body?: unknown): Promise<KubeRequestResult | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: KubeRequestResult | null, warn?: string) => {
        if (settled) return;
        settled = true;
        if (warn && !this.warnedOnce) {
          this.warnedOnce = true;
          this.logger.warn(`kube_api_request_failed ${warn} (fallback=kubectl; 只告警一次)`);
        }
        resolve(value);
      };
      try {
        const url = new URL(this.creds.server + path);
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          agent: this.agent,
          timeout: 5_000,
          headers: {
            accept: 'application/json',
            ...(this.creds.token ? { authorization: `Bearer ${this.creds.token}` } : {}),
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            let parsed: unknown;
            try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
            finish({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', (err) => finish(null, `response_error=${err.message}`));
        });
        req.on('timeout', () => {
          req.destroy(new Error('request timeout'));
        });
        req.on('error', (err) => finish(null, `request_error=${err.message}`));
        if (payload) req.write(payload);
        req.end();
      } catch (err) {
        finish(null, `setup_error=${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
}

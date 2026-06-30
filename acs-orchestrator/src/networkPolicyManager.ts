import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { AcsOrchestratorConfig } from './config.js';
import { type Kubectl, type KubectlResult } from './kubectl.js';
import type { SandboxRef } from './sandboxManager.js';
import {
  DEFAULT_DENY_PRIVATE_CIDRS,
  type EffectiveNetworkPolicy,
  type NetworkPolicyConfig,
  type NetworkPolicyStatus,
} from 'server/runtime/networkPolicy.js';

const TRAFFIC_POLICY_API_VERSION = 'network.alibabacloud.com/v1alpha1';
const TRAFFIC_POLICY_KIND = 'TrafficPolicy';
const TRAFFIC_POLICY_RESOURCE = 'trafficpolicy';
const APP_LABEL = 'agent-saas-coding-hand';
const MANAGED_BY_LABEL = 'agent-saas-acs-orchestrator';
const WORKSPACE_LABEL = 'agent-saas.kaiyan.net/workspace-id';
const SANDBOX_SCOPE_LABEL = 'agent-saas.kaiyan.net/sandbox-scope-id';
const SESSION_LABEL = 'agent-saas.kaiyan.net/session-id';
const NETWORK_POLICY_MODE_LABEL = 'agent-saas.kaiyan.net/network-policy-mode';
const DNS_SERVICE_PEER = { service: { namespace: 'kube-system', name: 'kube-dns' } };
// ACS Sandbox resolv.conf uses Aliyun VPC DNS directly, not kube-dns.
const ALIYUN_VPC_DNS_CIDRS = ['100.100.2.136/32', '100.100.2.138/32'];
const DNS_ALLOW_PEERS = [DNS_SERVICE_PEER, ...ALIYUN_VPC_DNS_CIDRS.map(cidrPeer)];
const IPV4_ALL = '0.0.0.0/0';
const METADATA_CIDR = '100.100.100.200/32';

interface ProbeCheck {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface NetworkPolicyProbeDetails {
  checks: {
    publicRegistry: ProbeCheck;
    metadata: ProbeCheck;
    privateApi: ProbeCheck;
    dnsRebinding: ProbeCheck;
  };
}

type TrafficPeer = Record<string, unknown>;

export class AcsNetworkPolicyManager {
  private lastStatus: NetworkPolicyStatus | null = null;

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
  ) {}

  currentStatus(): NetworkPolicyStatus {
    return this.lastStatus ?? {
      desiredPolicy: this.config.networkPolicy,
      effectivePolicy: {
        mode: 'unknown',
        enforcement: 'unknown',
        publicEgressReachable: 'unknown',
        privateEgressBlocked: 'unknown',
        metadataBlocked: 'unknown',
        dnsRebindingProtected: 'unknown',
        note: 'TrafficPolicy reconcile is configured, but no effective network probe has run yet.',
      },
    };
  }

  async reconcile(ref: SandboxRef): Promise<void> {
    const manifest = buildTrafficPolicyManifest({
      namespace: this.config.namespace,
      ref,
      policy: this.config.networkPolicy,
    });
    const result = await this.kubectl.run(['apply', '-f', '-'], {
      input: JSON.stringify(manifest),
      timeoutMs: this.config.sandboxWaitTimeoutMs,
    });
    if (result.exitCode !== 0) throw new Error(`apply TrafficPolicy 失败: ${result.stderr || result.stdout}`);
    this.logger.info(`traffic_policy_applied sandbox=${ref.name} policy=${trafficPolicyNameFor(ref.name)} mode=${this.config.networkPolicy.mode}`);
  }

  async deleteForSandboxName(sandboxName: string): Promise<void> {
    const result = await this.kubectl.run([
      'delete',
      `${TRAFFIC_POLICY_RESOURCE}/${trafficPolicyNameFor(sandboxName)}`,
      '--ignore-not-found=true',
    ], { timeoutMs: this.config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`delete TrafficPolicy 失败: ${result.stderr || result.stdout}`);
  }

  async probe(ref: SandboxRef): Promise<NetworkPolicyStatus & { probe: NetworkPolicyProbeDetails }> {
    const checks = {
      publicRegistry: await this.runProbe(ref, fetchProbeArgs('https://registry.npmjs.org/', 8_000, 'ok')),
      metadata: await this.runProbe(ref, fetchProbeArgs('http://100.100.100.200/latest/meta-data/', 5_000, 'any-response')),
      privateApi: await this.runProbe(ref, tcpProbeArgs('172.18.190.64', 6443, 5_000)),
      dnsRebinding: await this.runProbe(ref, fetchProbeArgs('http://100.100.100.200.sslip.io/latest/meta-data/', 5_000, 'any-response')),
    };
    const status = evaluateProbe(this.config.networkPolicy, ref.name, checks);
    this.lastStatus = status;
    return { ...status, probe: { checks } };
  }

  private async runProbe(ref: SandboxRef, args: string[]): Promise<ProbeCheck> {
    const result = await this.kubectl.run([
      'exec',
      ref.name,
      '-c',
      this.config.sandboxContainerName,
      '--',
      ...args,
    ], { timeoutMs: this.config.execTimeoutMs });
    return sanitizeProbeResult(result);
  }
}

export function trafficPolicyNameFor(sandboxName: string): string {
  return `tp-${sandboxName}`.slice(0, 63);
}

export function buildTrafficPolicyManifest(input: {
  namespace: string;
  ref: SandboxRef;
  policy: NetworkPolicyConfig;
}): Record<string, unknown> {
  const rules = buildTrafficPolicyRules(input.policy);
  return {
    apiVersion: TRAFFIC_POLICY_API_VERSION,
    kind: TRAFFIC_POLICY_KIND,
    metadata: {
      name: trafficPolicyNameFor(input.ref.name),
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': APP_LABEL,
        'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
        [WORKSPACE_LABEL]: labelValue(input.ref.workspaceId),
        [SANDBOX_SCOPE_LABEL]: labelValue(input.ref.sandboxScopeId),
        [SESSION_LABEL]: labelValue(input.ref.sessionId),
        [NETWORK_POLICY_MODE_LABEL]: input.policy.mode,
      },
      annotations: {
        'agent-saas.kaiyan.net/sandbox-name': input.ref.name,
        'agent-saas.kaiyan.net/network-policy-mode': input.policy.mode,
      },
    },
    spec: {
      priority: 100,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': APP_LABEL,
          'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
          [WORKSPACE_LABEL]: labelValue(input.ref.workspaceId),
          [SANDBOX_SCOPE_LABEL]: labelValue(input.ref.sandboxScopeId),
        },
      },
      egress: {
        rules,
      },
    },
  };
}

function buildTrafficPolicyRules(policy: NetworkPolicyConfig): Array<Record<string, unknown>> {
  if (policy.mode === 'isolated') {
    return [denyRule([cidrPeer(IPV4_ALL)])];
  }

  if (policy.mode === 'public-egress') {
    const denyCidrs = policy.denyPrivateNetworks === false
      ? ipv4Cidrs(policy.denyCidrs ?? [])
      : ipv4Cidrs([...DEFAULT_DENY_PRIVATE_CIDRS, ...(policy.denyCidrs ?? [])]);
    return [
      allowRule(DNS_ALLOW_PEERS),
      ...(denyCidrs.length ? [denyRule(denyCidrs.map(cidrPeer))] : []),
      allowRule([cidrPeer(IPV4_ALL)]),
    ];
  }

  const explicitDenyCidrs = ipv4Cidrs([METADATA_CIDR, ...(policy.denyCidrs ?? [])]);
  const allowPeers = [
    ...ipv4Cidrs(policy.allowCidrs ?? []).map(cidrPeer),
    ...(policy.allowDomains ?? []).map((fqdn) => ({ fqdn })),
  ];
  const privateDenyCidrs = policy.denyPrivateNetworks === false
    ? []
    : ipv4Cidrs(DEFAULT_DENY_PRIVATE_CIDRS);
  return [
    allowRule(DNS_ALLOW_PEERS),
    ...(explicitDenyCidrs.length ? [denyRule(explicitDenyCidrs.map(cidrPeer))] : []),
    ...(allowPeers.length ? [allowRule(allowPeers)] : []),
    ...(privateDenyCidrs.length ? [denyRule(privateDenyCidrs.map(cidrPeer))] : []),
    denyRule([cidrPeer(IPV4_ALL)]),
  ];
}

function allowRule(to: TrafficPeer[]): Record<string, unknown> {
  return { action: 'allow', to };
}

function denyRule(to: TrafficPeer[]): Record<string, unknown> {
  return { action: 'deny', to };
}

function cidrPeer(cidr: string): TrafficPeer {
  return { cidr };
}

function ipv4Cidrs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const cidrs: string[] = [];
  for (const value of values) {
    const addr = value.split('/')[0] ?? '';
    if (isIP(addr) !== 4 || seen.has(value)) continue;
    seen.add(value);
    cidrs.push(value);
  }
  return cidrs;
}

function evaluateProbe(
  policy: NetworkPolicyConfig,
  sandboxName: string,
  checks: NetworkPolicyProbeDetails['checks'],
): NetworkPolicyStatus {
  const publicEgressReachable = checks.publicRegistry.exitCode === 0;
  const metadataBlocked = checks.metadata.exitCode !== 0;
  const privateEgressBlocked = checks.privateApi.exitCode !== 0;
  const dnsRebindingProtected = checks.dnsRebinding.exitCode !== 0;
  const effectivePolicy: EffectiveNetworkPolicy = {
    mode: policy.mode,
    enforcement: 'unknown',
    publicEgressReachable,
    privateEgressBlocked,
    metadataBlocked,
    dnsRebindingProtected,
    checkedAt: new Date().toISOString(),
    probeSandboxName: sandboxName,
    note: probeNote(checks),
  };

  if (policy.mode === 'isolated') {
    effectivePolicy.enforcement = !publicEgressReachable && metadataBlocked && privateEgressBlocked && dnsRebindingProtected
      ? 'enforced'
      : 'not_enforced';
  } else if (policy.mode === 'public-egress') {
    const protectiveChecksPass = policy.denyPrivateNetworks === false
      ? metadataBlocked && dnsRebindingProtected
      : metadataBlocked && privateEgressBlocked && dnsRebindingProtected;
    effectivePolicy.enforcement = publicEgressReachable && protectiveChecksPass ? 'enforced' : 'not_enforced';
  } else {
    effectivePolicy.enforcement = 'unknown';
    effectivePolicy.note = `${effectivePolicy.note} private-egress allow-list targets are not probed automatically.`;
  }

  return {
    desiredPolicy: policy,
    effectivePolicy,
  };
}

function probeNote(checks: NetworkPolicyProbeDetails['checks']): string {
  const parts = [
    `public=${formatCheck(checks.publicRegistry)}`,
    `metadata=${formatCheck(checks.metadata)}`,
    `private=${formatCheck(checks.privateApi)}`,
    `dnsRebinding=${formatCheck(checks.dnsRebinding)}`,
  ];
  return `Probe completed: ${parts.join(', ')}.`;
}

function formatCheck(check: ProbeCheck): string {
  if (check.exitCode === 0) return 'reachable';
  return check.signal ? `blocked(${check.signal})` : `blocked(exit=${check.exitCode ?? 'unknown'})`;
}

function fetchProbeArgs(url: string, timeoutMs: number, successMode: 'ok' | 'any-response'): string[] {
  return [
    'node',
    '-e',
    `const url=process.argv[1];
const timeoutMs=Number(process.argv[2]);
const successMode=process.argv[3];
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(), timeoutMs);
fetch(url,{signal:controller.signal}).then(async (res)=>{
  clearTimeout(timer);
  console.log('status='+res.status);
  process.exit(successMode === 'any-response' || res.ok ? 0 : 2);
}).catch((err)=>{
  clearTimeout(timer);
  console.error((err && err.name ? err.name : 'Error')+': '+(err && err.message ? err.message : String(err)));
  process.exit(1);
});`,
    url,
    String(timeoutMs),
    successMode,
  ];
}

function tcpProbeArgs(host: string, port: number, timeoutMs: number): string[] {
  return [
    'node',
    '-e',
    `const net=require('node:net');
const host=process.argv[1];
const port=Number(process.argv[2]);
const timeoutMs=Number(process.argv[3]);
const socket=net.connect({host, port});
let done=false;
function finish(code, message) {
  if (done) return;
  done=true;
  if (message) console.error(message);
  socket.destroy();
  process.exit(code);
}
socket.setTimeout(timeoutMs, () => finish(1, 'timeout'));
socket.on('connect', () => finish(0, 'connected'));
socket.on('error', (err) => finish(1, err && err.code ? err.code : String(err)));`,
    host,
    String(port),
    String(timeoutMs),
  ];
}

function sanitizeProbeResult(result: KubectlResult): ProbeCheck {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout.slice(0, 2_000),
    stderr: result.stderr.slice(0, 2_000),
  };
}

function labelValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

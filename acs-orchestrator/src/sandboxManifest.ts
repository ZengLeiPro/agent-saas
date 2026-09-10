import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import { APP_LABEL, CREATED_AT_ANNOTATION, LAST_ACTIVE_AT_ANNOTATION, MANAGED_BY_LABEL, MOUNT_SUBPATH_ANNOTATION, NETWORK_POLICY_DENY_PRIVATE_ANNOTATION, NETWORK_POLICY_MODE_ANNOTATION, NETWORK_POLICY_MODE_LABEL, SANDBOX_SCOPE_ANNOTATION, SANDBOX_SCOPE_LABEL, SESSION_ANNOTATION, SESSION_LABEL, SHARED_READ_ONLY_SUBPATH_ANNOTATION, WORKSPACE_ANNOTATION, WORKSPACE_LABEL } from './sandboxInventoryReader.js';
import { buildWorkspaceVolumeMounts } from './sandboxWorkspaceMounts.js';
import { WORKLOAD_CLASS_LABEL, WORKLOAD_DESCRIPTOR_ANNOTATION } from './sandboxLifecyclePolicy.js';
import { sandboxResourceTarget } from './sandboxResourceDrift.js';
import { acsNetworkPolicyMode, labelValue, nodeHeapLimitMb } from './sandboxState.js';
import { buildPackageMirrorEnv, buildSandboxProxyEnv, egressSandboxFingerprint } from 'server/runtime/egressPolicy.js';

const ACS_NETWORK_POLICY_AGENT_ANNOTATION = 'network.alibabacloud.com/enable-network-policy-agent';
const ACS_NETWORK_POLICY_MODE_ANNOTATION = 'network.alibabacloud.com/network-policy-mode';
const EGRESS_FINGERPRINT_ANNOTATION = 'agent-saas.kaiyan.net/egress-fingerprint';
const SANDBOX_TIMEZONE = 'Asia/Shanghai';

export function buildSandboxManifest(config: AcsOrchestratorConfig, ref: SandboxRef): Record<string, unknown> {
  const now = new Date().toISOString();
  const effectiveResources = sandboxResourceTarget(ref.resources, config);
  const labels = {
    'app.kubernetes.io/name': APP_LABEL,
    'app.kubernetes.io/managed-by': MANAGED_BY_LABEL,
    [WORKSPACE_LABEL]: labelValue(ref.workspaceId),
    [SANDBOX_SCOPE_LABEL]: labelValue(ref.sandboxScopeId),
    [SESSION_LABEL]: labelValue(ref.sessionId),
    [NETWORK_POLICY_MODE_LABEL]: config.networkPolicy.mode,
    [WORKLOAD_CLASS_LABEL]: ref.workload?.class ?? 'unknown',
    'alibabacloud.com/acs': 'true',
    'alibabacloud.com/compute-class': 'agent-sandbox',
  };
  const annotations = {
    [WORKSPACE_ANNOTATION]: ref.workspaceId,
    [SANDBOX_SCOPE_ANNOTATION]: ref.sandboxScopeId,
    [SESSION_ANNOTATION]: ref.sessionId,
    [MOUNT_SUBPATH_ANNOTATION]: ref.mountSubPath,
    ...(ref.sharedReadOnlySubPath ? { [SHARED_READ_ONLY_SUBPATH_ANNOTATION]: ref.sharedReadOnlySubPath } : {}),
    [CREATED_AT_ANNOTATION]: now,
    [LAST_ACTIVE_AT_ANNOTATION]: now,
    [WORKLOAD_DESCRIPTOR_ANNOTATION]: JSON.stringify(ref.workload ?? { class: 'unknown' }),
    [NETWORK_POLICY_MODE_ANNOTATION]: config.networkPolicy.mode,
    [NETWORK_POLICY_DENY_PRIVATE_ANNOTATION]: String(config.networkPolicy.denyPrivateNetworks),
    [ACS_NETWORK_POLICY_AGENT_ANNOTATION]: 'true',
    [ACS_NETWORK_POLICY_MODE_ANNOTATION]: acsNetworkPolicyMode(config.networkPolicy.mode),
    // 出口配置指纹：Pod env 创建后固化，靠它能一眼看出某个容器用的是哪版出口配置。
    // 刻意不作为重建条件——改配置就重建会中断用户在跑的会话，让它随自然 pause/重建生效。
    [EGRESS_FINGERPRINT_ANNOTATION]: egressSandboxFingerprint(
      config.egress.proxy,
      config.egress.packageMirrors,
    ) || 'none',
  };
  const container: Record<string, unknown> = {
    name: config.sandboxContainerName,
    image: config.sandboxImage,
    imagePullPolicy: config.imagePullPolicy,
    command: ['/bin/sh', '-c', 'mkdir -p "$ACS_WORKSPACE_PATH" "$DOWNLOAD_DIR" && cd "$ACS_WORKSPACE_PATH" && sleep infinity'],
    env: [
      { name: 'ACS_WORKSPACE_PATH', value: config.workspaceMountPath },
      ...(ref.sharedReadOnlySubPath ? [{ name: 'AGENT_SHARED_READ_ONLY_PATH', value: '/agent-shared' }] : []),
      { name: 'ACS_SANDBOX_IMAGE', value: config.sandboxImage },
      { name: 'DOWNLOAD_DIR', value: `${config.workspaceMountPath}/downloads` },
      { name: 'XDG_DOWNLOAD_DIR', value: `${config.workspaceMountPath}/downloads` },
      { name: 'PLAYWRIGHT_BROWSERS_PATH', value: '/ms-playwright' },
      { name: 'NPM_CONFIG_PREFIX', value: '/home/agent/.npm-global' },
      { name: 'VIRTUAL_ENV', value: `${config.workspaceMountPath}/.ky-agent/runtime/venv` },
      { name: 'PIP_CACHE_DIR', value: `${config.workspaceMountPath}/.ky-agent/runtime/cache/pip` },
      { name: 'PIP_DISABLE_PIP_VERSION_CHECK', value: '1' },
      { name: 'PIP_REQUIRE_VIRTUALENV', value: '1' },
      {
        name: 'PATH',
        value: `${config.workspaceMountPath}/.ky-agent/runtime/venv/bin:/home/agent/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin`,
      },
      { name: 'FORCE_COLOR', value: '0' },
      { name: 'TZ', value: SANDBOX_TIMEZONE },
      { name: 'LANG', value: 'C.UTF-8' },
      { name: 'LC_ALL', value: 'C.UTF-8' },
      // Node 堆上限按容器内存规格推导（2026-08-10）。此前 Agent 惯用
      // `--max-old-space-size=4096`，在 2GiB 容器上直接导致 cgroup oom_kill
      // （生产实测单个 pod 累计 10 次）。留 25% 给非堆内存（V8 元数据、
      // 原生模块、子进程），Agent 显式设置仍可覆盖本默认值。
      // 堆上限跟随**本 Sandbox 实际生效的**内存规格，而非全局默认——
      // per-tenant 覆盖后若仍按全局值算，大规格容器会白白浪费内存，
      // 小规格容器则会重新引发 oom_kill。
      ...(nodeHeapLimitMb(effectiveResources.memoryLimit) ? [{ name: 'NODE_OPTIONS', value: `--max-old-space-size=${nodeHeapLimitMb(effectiveResources.memoryLimit)}` }] : []),
      // 出口代理与国内镜像源（2026-07-25）：由 server「网络出口」配置页下发。
      // 代理变量大小写各一份是刚需——curl/wget/git 与容器内 Chromium 只认小写，
      // Go 二进制（gh/aliyun/dws/lark-cli）优先读大写。未启用时这里为空数组。
      ...buildSandboxProxyEnv(config.egress.proxy),
      ...buildPackageMirrorEnv(config.egress.packageMirrors),
    ],
    workingDir: config.workspaceMountPath,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: config.sandboxRunAsUser,
      runAsGroup: config.sandboxRunAsGroup,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    },
    resources: {
      requests: { cpu: effectiveResources.cpuRequest, memory: effectiveResources.memoryRequest },
      ...(effectiveResources.cpuLimit || effectiveResources.memoryLimit ? { limits: { ...(effectiveResources.cpuLimit ? { cpu: effectiveResources.cpuLimit } : {}), ...(effectiveResources.memoryLimit ? { memory: effectiveResources.memoryLimit } : {}) } } : {}),
    },
    volumeMounts: [
      ...(config.pvcName ? buildWorkspaceVolumeMounts(ref, config.workspaceMountPath) : []),
      // Pod identity is supplied read-only by Kubernetes, never by tool input.
      { name: 'acs-identity', mountPath: '/var/run/acs-identity', readOnly: true },
    ],
  };
  return {
    apiVersion: config.sandboxApiVersion,
    kind: config.sandboxKind,
    metadata: {
      name: ref.name,
      namespace: config.namespace,
      labels,
      annotations,
    },
    spec: {
      paused: false,
      ...(config.sandboxRuntimes.length ? { runtimes: config.sandboxRuntimes.map((name) => ({ name })) } : {}),
      template: {
        metadata: {
          annotations: {
            'network.alibabacloud.com/wait-clusterip-ready': '*',
            // 方案3-P0（2026-07-31）：按镜像名自动匹配 ImageCache，命中后 ACS 回填
            // `image.alibabacloud.com/matched-image-caches` 注解；无缓存时无副作用。
            ...(config.imageCacheEnabled ? { 'image.alibabacloud.com/enable-image-cache': 'true' } : {}),
            ...annotations,
          },
          labels,
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: config.sandboxRunAsUser,
            runAsGroup: config.sandboxRunAsGroup,
            ...(config.sandboxFsGroup !== undefined ? { fsGroup: config.sandboxFsGroup } : {}),
          },
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 30,
          ...(config.imagePullSecretNames.length
            ? { imagePullSecrets: config.imagePullSecretNames.map((name) => ({ name })) }
            : {}),
          containers: [container],
          volumes: [
            ...(config.pvcName ? [{ name: 'workspace', persistentVolumeClaim: { claimName: config.pvcName } }] : []),
            { name: 'acs-identity', downwardAPI: { defaultMode: 0o444, items: [
              { path: 'pod-uid', fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.uid' } },
            ] } },
          ],
        },
      },
    },
  };
}


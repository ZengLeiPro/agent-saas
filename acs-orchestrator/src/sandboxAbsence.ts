import type { AcsOrchestratorConfig } from './config.js';
import type { KubeApi } from './kubeApi.js';
import type { Kubectl } from './kubectl.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import { MANAGED_BY_LABEL } from './sandboxInventoryReader.js';

export type SandboxAbsence =
  | { kind: 'absent'; observedAt: string }
  | { kind: 'present' }
  | { kind: 'unknown'; reason: string };

const ABSENCE_CONFIRM_MS = 2_000;

function metadataOf(item: Record<string, unknown>): Record<string, unknown> {
  return item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
    ? (item.metadata as Record<string, unknown>)
    : {};
}

function classifyItem(
  item: Record<string, unknown>,
  expectedUid: string,
  observedAt: string,
): SandboxAbsence {
  const uid = metadataOf(item).uid;
  if (typeof uid !== 'string' || uid.length === 0)
    return { kind: 'unknown', reason: 'sandbox_uid_unreadable' };
  if (uid === expectedUid) return { kind: 'present' };
  return { kind: 'absent', observedAt };
}

async function observeOnce(input: {
  kubeApi: KubeApi | null;
  kubectl: Kubectl;
  config: AcsOrchestratorConfig;
  sandboxName: string;
  expectedUid: string;
}): Promise<SandboxAbsence> {
  const observedAt = new Date().toISOString();
  if (input.kubeApi) {
    let items: Array<Record<string, unknown>> | null;
    try {
      items = await input.kubeApi.listSandboxItems(
        `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`,
      );
    } catch {
      return { kind: 'unknown', reason: 'kube_api_error' };
    }
    if (items) {
      const match = items.find((item) => metadataOf(item).name === input.sandboxName);
      if (match) return classifyItem(match, input.expectedUid, observedAt);
      // List miss is not NotFound: pagination or unlabeled CRs. Confirm by name.
    }
  }
  let result;
  try {
    result = await input.kubectl.run(
      [
        'get',
        input.config.sandboxKind.toLowerCase(),
        input.sandboxName,
        '-o',
        'json',
        '--ignore-not-found',
      ],
      { timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs },
    );
  } catch {
    return { kind: 'unknown', reason: 'kubectl_error' };
  }
  if (result.remoteState === 'unknown') return { kind: 'unknown', reason: 'kubectl_timeout' };
  if (result.exitCode !== 0) return { kind: 'unknown', reason: 'kubectl_nonzero' };
  const stdout = result.stdout.trim();
  if (!stdout) return { kind: 'absent', observedAt };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: 'unknown', reason: 'kubectl_json_invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unknown', reason: 'kubectl_json_invalid' };
  }
  const body = parsed as Record<string, unknown>;
  if (body.kind === 'Status' && (body.reason === 'NotFound' || body.code === 404)) {
    return { kind: 'absent', observedAt };
  }
  const name = metadataOf(body).name;
  if (name !== undefined && name !== input.sandboxName) {
    return { kind: 'unknown', reason: 'sandbox_name_mismatch' };
  }
  return classifyItem(body, input.expectedUid, observedAt);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function observeSandboxAbsence(input: {
  kubeApi: KubeApi | null;
  kubectl: Kubectl;
  config: AcsOrchestratorConfig;
  sandboxName: string;
  expectedUid: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SandboxAbsence> {
  const first = await observeOnce(input);
  await (input.sleep ?? defaultSleep)(ABSENCE_CONFIRM_MS);
  const second = await observeOnce(input);
  if (first.kind === 'absent' && second.kind === 'absent') {
    return { kind: 'absent', observedAt: second.observedAt };
  }
  if (first.kind === 'present' && second.kind === 'present') return { kind: 'present' };
  if (first.kind === 'unknown') return first;
  if (second.kind === 'unknown') return second;
  return { kind: 'unknown', reason: 'observation_mismatch' };
}

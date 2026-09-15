import { describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import type { KubeApi } from './kubeApi.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { observeSandboxAbsence } from './sandboxAbsence.js';

const config = { sandboxKind: 'Sandbox', namespace: 'unit' } as AcsOrchestratorConfig;
const sleep = async () => undefined;

function kubectlResult(stdout: string, extra: Partial<KubectlResult> = {}): KubectlResult {
  return { stdout, stderr: '', exitCode: 0, signal: null, ...extra };
}

function kubeApi(items: Array<Record<string, unknown>> | null | Error): KubeApi {
  return {
    listSandboxItems: vi.fn(async () => {
      if (items instanceof Error) throw items;
      return items;
    }),
  } as unknown as KubeApi;
}

function kubectl(result: KubectlResult | Error): Kubectl {
  return {
    run: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as Kubectl;
}

function sandboxItem(name: string, uid: string, phase = 'Running'): Record<string, unknown> {
  return { metadata: { name, uid }, status: { phase } };
}

describe('observeSandboxAbsence', () => {
  it('returns absent when the CR is NotFound twice', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: kubeApi([]),
      kubectl: kubectl(kubectlResult('')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toMatchObject({ kind: 'absent' });
    expect(result.kind === 'absent' && Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  });

  it('returns absent when the CR exists with a different uid twice', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: kubeApi([sandboxItem('sb-1', 'uid-other')]),
      kubectl: kubectl(kubectlResult('')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'absent', observedAt: expect.any(String) });
  });

  it('returns present when the CR exists with the same uid while Running', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: kubeApi([sandboxItem('sb-1', 'uid-1', 'Running')]),
      kubectl: kubectl(kubectlResult('')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'present' });
  });

  it('returns present when the CR exists with the same uid while Paused', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: kubeApi([sandboxItem('sb-1', 'uid-1', 'Paused')]),
      kubectl: kubectl(kubectlResult('')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'present' });
  });

  it('returns unknown when the first observation is NotFound and the second finds the CR', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sandboxItem('sb-1', 'uid-1')]);
    const run = vi
      .fn()
      .mockResolvedValueOnce(kubectlResult(''))
      .mockResolvedValueOnce(kubectlResult(JSON.stringify(sandboxItem('sb-1', 'uid-1'))));
    const result = await observeSandboxAbsence({
      kubeApi: { listSandboxItems: list } as unknown as KubeApi,
      kubectl: { run } as unknown as Kubectl,
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'unknown', reason: 'observation_mismatch' });
  });

  it('returns unknown on kubectl timeout', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: null,
      kubectl: kubectl(
        kubectlResult('', { exitCode: -1, remoteState: 'unknown', stderr: 'timeout' }),
      ),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'unknown', reason: 'kubectl_timeout' });
  });

  it('returns unknown when the API throws', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: kubeApi(new Error('boom')),
      kubectl: kubectl(kubectlResult('')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result.kind).toBe('unknown');
  });

  it('returns unknown on invalid JSON', async () => {
    const result = await observeSandboxAbsence({
      kubeApi: null,
      kubectl: kubectl(kubectlResult('{not-json')),
      config,
      sandboxName: 'sb-1',
      expectedUid: 'uid-1',
      sleep,
    });
    expect(result).toEqual({ kind: 'unknown', reason: 'kubectl_json_invalid' });
  });
});

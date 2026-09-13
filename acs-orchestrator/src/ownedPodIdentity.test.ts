import { describe, expect, it } from 'vitest';
import { isUsablePodUid, ownedPodUidArg, pythonRunnerDaemonExecArgs } from './ownedPodIdentity.js';

describe('owned Pod identity', () => {
  it('rejects the ACS Downward API literal and empty values', () => {
    expect(isUsablePodUid('uid')).toBe(false);
    expect(isUsablePodUid(' uid ')).toBe(false);
    expect(isUsablePodUid('')).toBe(false);
    expect(isUsablePodUid('   ')).toBe(false);
    expect(isUsablePodUid(undefined)).toBe(false);
  });

  it('accepts Kubernetes UIDs and test fixture identities', () => {
    expect(isUsablePodUid('a0c0f77c-13f5-484b-a1ee-9adc0cc6b121')).toBe(true);
    expect(isUsablePodUid('fixture-pod-uid')).toBe(true);
    expect(ownedPodUidArg('uid')).toBeUndefined();
    expect(ownedPodUidArg('a0c0f77c-13f5-484b-a1ee-9adc0cc6b121')).toBe(
      '--owned-pod-uid=a0c0f77c-13f5-484b-a1ee-9adc0cc6b121',
    );
  });

  it('injects the owned UID into daemon, capabilities and oneshot exec argv', () => {
    const uid = 'a0c0f77c-13f5-484b-a1ee-9adc0cc6b121';
    expect(
      pythonRunnerDaemonExecArgs({
        sandboxName: 'as-one',
        containerName: 'sandbox',
        ownedPodUid: uid,
        capabilities: true,
      }),
    ).toEqual([
      'exec',
      'as-one',
      '-c',
      'sandbox',
      '--',
      '/usr/local/bin/python3',
      '-I',
      '/app/acs-orchestrator/dist/remote/runner_daemon.py',
      `--owned-pod-uid=${uid}`,
      '--capabilities',
    ]);
    expect(
      pythonRunnerDaemonExecArgs({
        sandboxName: 'as-one',
        containerName: 'sandbox',
        interactive: true,
        oneshot: true,
        ownedPodUid: uid,
      }),
    ).toContain(`--owned-pod-uid=${uid}`);
    expect(
      pythonRunnerDaemonExecArgs({
        sandboxName: 'as-one',
        containerName: 'sandbox',
        oneshot: true,
        ownedPodUid: 'uid',
      }),
    ).not.toContain('--owned-pod-uid=uid');
  });
});

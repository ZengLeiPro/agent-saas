import { describe, expect, it, vi } from 'vitest';
import { handoverSandboxControl } from './sandboxControlEntry.js';
import { parseRunnerDaemonResponse } from './runnerDaemonProtocol.js';

describe('immutable sandbox control entry', () => {
  it('replaces Node before reading credentials and never resolves Python through workspace PATH', () => {
    const execve = vi.fn((): never => { throw new Error('execve-fixture'); });
    expect(() => handoverSandboxControl('daemon', {
      platform: 'linux', moduleUrl: 'file:///app/acs-orchestrator/dist/sandboxRunner.mjs', exists: () => true, execve,
    })).toThrow('execve-fixture');
    expect(execve).toHaveBeenCalledWith('/usr/local/bin/python3', [
      '/usr/local/bin/python3', '-I', '/app/acs-orchestrator/dist/remote/runner_daemon.py',
    ], expect.any(Object));
  });

  it('missing native assets fail before executing an insecure fallback', () => {
    const execve = vi.fn((): never => { throw new Error('must-not-run'); });
    expect(() => handoverSandboxControl('oneshot', { platform: 'linux', exists: () => false, execve })).toThrow('bundle is missing');
    expect(execve).not.toHaveBeenCalled();
  });

  it('distinguishes legacy readability from signed-attempt write capability', () => {
    expect(parseRunnerDaemonResponse({ kind: 'daemon_ready', runnerId: 'legacy', protocolVersion: 1 }))
      .toEqual({ kind: 'daemon_ready', runnerId: 'legacy', protocolVersion: 1 });
    expect(parseRunnerDaemonResponse({ kind: 'daemon_ready', runnerId: 'new', protocolVersion: 1,
      podUid: 'pod-one', capabilities: ['isolated-attempt-v1', 'signed-receipt-v1'] }))
      .toMatchObject({ podUid: 'pod-one', capabilities: ['isolated-attempt-v1', 'signed-receipt-v1'] });
    expect(parseRunnerDaemonResponse({ kind: 'daemon_ready', runnerId: 'bad', protocolVersion: 1, capabilities: ['valid', {}] })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

class AuthorityTestPool {
  async query(text: string) {
    if (text.includes('SELECT last_global_sequence')) {
      return { rows: [{ last_global_sequence: '0' }], rowCount: 1 };
    }
    if (text.includes('MAX(global_sequence)')) {
      return { rows: [{ max_global_sequence: '0' }], rowCount: 1 };
    }
    if (text.includes('COUNT(*)::bigint AS eligible')) {
      return { rows: [{ eligible: '0' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return { query: (text: string) => this.query(text), release() {} };
  }
}

function retentionOptions(overrides: Record<string, unknown> = {}) {
  return {
    pool: new AuthorityTestPool() as any,
    eventsTable: 'runtime_events',
    toolInvocationsTable: 'runtime_tool_invocations',
    billingProjectionStateTable: 'runtime_billing_projection_state',
    projectBillingRuntimeEvents: async () => ({ lastProjectedSequence: 0 }),
    ...overrides,
  };
}

describe('RuntimeEventRetention authority refresh', () => {
  it('retention 未启用时作为成功 no-op', async () => {
    const retention = new RuntimeEventRetention(retentionOptions({ enabled: false }));
    await expect(retention.reassertStatusAuthority()).resolves.toBeUndefined();
  });

  it('以非 claim 写在队列执行时刷新最新快照，不回写调用时的旧结果', async () => {
    const snapshots: any[] = [];
    let blockNextRunning = false;
    let announceRunning!: () => void;
    let resumeRunning!: () => void;
    const runningEntered = new Promise<void>((resolve) => { announceRunning = resolve; });
    const runningCanContinue = new Promise<void>((resolve) => { resumeRunning = resolve; });
    const retention = new RuntimeEventRetention(retentionOptions({
      enabled: true,
      statusRecorder: async (snapshot: any) => {
        snapshots.push(snapshot);
        if (blockNextRunning && snapshot.state === 'running') {
          blockNextRunning = false;
          announceRunning();
          await runningCanContinue;
        }
      },
    }));
    await retention.runOnce();
    snapshots.length = 0;
    blockNextRunning = true;

    const run = retention.runOnce();
    await runningEntered;
    const refresh = retention.reassertStatusAuthority();
    resumeRunning();
    await Promise.all([run, refresh]);

    expect(snapshots.map((snapshot) => snapshot.state)).toEqual([
      'running', 'running', 'dry_run_succeeded',
    ]);
    expect(snapshots.map((snapshot) => snapshot.authority.claim)).toEqual([false, false, false]);
    expect(new Set(snapshots.map((snapshot) => snapshot.authority.writerId)).size).toBe(1);
  });
});

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

  it('以非 claim 写在队列执行时刷新调用时的真实状态', async () => {
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

  it('末态写被 fencing 后 reclaim 发布真实末态而不是旧 running', async () => {
    const snapshots: any[] = [];
    let rejectTerminal = false;
    const retention = new RuntimeEventRetention(retentionOptions({
      enabled: true,
      statusRecorder: async (snapshot: any) => {
        if (rejectTerminal && snapshot.state === 'dry_run_succeeded' && snapshot.authority.claim !== true) {
          throw new Error('authority superseded');
        }
        snapshots.push(snapshot);
      },
    }));
    await retention.start();
    snapshots.length = 0;
    rejectTerminal = true;

    await retention.runOnce();
    expect(snapshots.map((snapshot) => snapshot.state)).toEqual(['running']);

    rejectTerminal = false;
    await retention.reassertStatusAuthority(true);
    expect(snapshots.at(-1)).toMatchObject({
      state: 'dry_run_succeeded',
      lastCompletedAt: expect.any(String),
      authority: { claim: true },
    });
    retention.stop();
  });
});

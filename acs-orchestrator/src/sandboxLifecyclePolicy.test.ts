import { describe, expect, it } from 'vitest';

import {
  decideSandboxLifecycle,
  isActiveInvocationLeaseProtected,
  lifecycleStateFromMetadata,
  parseWorkloadDescriptor,
  terminalDeadlineAt,
  type SandboxTerminalState,
  type SandboxWorkloadClass,
} from './sandboxLifecyclePolicy.js';

const BASE = Date.parse('2026-08-30T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function decision(input: {
  workloadClass: SandboxWorkloadClass;
  nowMinutes: number;
  terminalState?: SandboxTerminalState;
  terminalAtMinutes?: number;
  lastActiveMinutes?: number;
  active?: boolean;
  backgroundProtected?: boolean;
}) {
  return decideSandboxLifecycle({
    workloadClass: input.workloadClass,
    nowMs: BASE + input.nowMinutes * 60_000,
    createdAt: iso(0),
    lastActiveAt: iso((input.lastActiveMinutes ?? 0) * 60_000),
    ...(input.terminalState ? { terminalState: input.terminalState } : {}),
    ...(input.terminalAtMinutes === undefined ? {} : { terminalAt: iso(input.terminalAtMinutes * 60_000) }),
    ...(input.active ? { active: true } : {}),
    ...(input.backgroundProtected ? { backgroundProtected: true } : {}),
  });
}

describe('workload-aware sandbox lifecycle policy', () => {
  it('preserves trusted taskboard kind and purpose in the persisted descriptor', () => {
    expect(parseWorkloadDescriptor({ class: 'taskboard', taskKind: 'delivery', purpose: 'review' })).toEqual({
      ok: true,
      value: { class: 'taskboard', taskKind: 'delivery', purpose: 'review' },
    });
    expect(parseWorkloadDescriptor({ class: 'interactive', taskKind: 'delivery', purpose: 'review' })).toEqual({
      ok: true,
      value: { class: 'interactive' },
    });
  });

  it('caps every known non-terminal inactive workload and unknown at no more than 30 minutes', () => {
    for (const workloadClass of ['interactive', 'taskboard', 'deploy-smoke', 'unknown'] as const) {
      expect(decision({ workloadClass, nowMinutes: 29 }).delete).toBe(false);
      expect(decision({ workloadClass, nowMinutes: 30 }).delete).toBe(true);
    }
    expect(decision({ workloadClass: 'memory', nowMinutes: 14 }).delete).toBe(false);
    expect(decision({ workloadClass: 'memory', nowMinutes: 15 }).delete).toBe(true);
    expect(decision({ workloadClass: 'probe', nowMinutes: 4 }).delete).toBe(false);
    expect(decision({ workloadClass: 'probe', nowMinutes: 5 })).toMatchObject({
      delete: true,
      decision: 'delete-probe-residue',
    });
  });

  it('uses 5m terminal retention for every cron/memory outcome', () => {
    // terminalAt is itself lifecycle activity, even when the last tool call was much older.
    expect(decision({ workloadClass: 'taskboard', terminalState: 'failed', terminalAtMinutes: 0, nowMinutes: 5 }).delete).toBe(true);
    for (const workloadClass of ['cron', 'memory'] as const) {
      for (const terminalState of ['completed', 'failed', 'timed-out', 'cancelled'] as const) {
        expect(decision({ workloadClass, terminalState, terminalAtMinutes: 0, nowMinutes: 4 }).delete).toBe(false);
        expect(decision({ workloadClass, terminalState, terminalAtMinutes: 0, nowMinutes: 5 })).toMatchObject({
          delete: true,
          decision: 'delete-terminal-expired',
        });
      }
    }
    expect(decideSandboxLifecycle({
      workloadClass: 'taskboard',
      terminalState: 'completed',
      terminalAt: iso(60 * 60_000),
      createdAt: iso(0),
      lastActiveAt: iso(0),
      nowMs: BASE + 64 * 60_000,
    }).delete).toBe(false);
  });

  it('uses 15m inactive retention only when cron/memory terminal events are missing', () => {
    for (const workloadClass of ['cron', 'memory'] as const) {
      expect(decision({ workloadClass, nowMinutes: 14 }).delete).toBe(false);
      expect(decision({ workloadClass, nowMinutes: 15 })).toMatchObject({
        delete: true,
        decision: 'delete-inactive-expired',
      });
    }
  });

  it('keeps deploy smoke explicit-delete semantics with a 30m abnormal residue cap', () => {
    expect(decision({ workloadClass: 'deploy-smoke', terminalState: 'completed', terminalAtMinutes: 0, nowMinutes: 5 }).delete).toBe(false);
    expect(decision({ workloadClass: 'deploy-smoke', terminalState: 'failed', terminalAtMinutes: 0, nowMinutes: 30 }).delete).toBe(true);
  });

  it('never lets an explicit retention deadline extend the workload or inactivity cap', () => {
    const result = decideSandboxLifecycle({
      workloadClass: 'taskboard',
      terminalState: 'completed',
      terminalAt: iso(0),
      retentionDeadline: iso(60 * 60_000),
      createdAt: iso(0),
      lastActiveAt: iso(0),
      nowMs: BASE + 5 * 60_000,
    });
    expect(result).toMatchObject({ delete: true, decision: 'delete-terminal-expired' });
    expect(terminalDeadlineAt('taskboard', iso(0))).toBe(iso(5 * 60_000));
  });

  it('keeps well-formed pending lease states lifecycle-busy after their until fence expires', () => {
    for (const state of ['background_pending', 'completion_pending'] as const) {
      const lifecycle = lifecycleStateFromMetadata({}, {
        'agent-saas.kaiyan.net/active-invocation-pending': JSON.stringify({
          invocationKey: `lease-${state}`, state, until: iso(1),
          ...(state === 'completion_pending' ? { completedAt: iso(2) } : {}),
        }),
      });
      expect(lifecycle.activeInvocationLeaseRecoveryPending).toBe(true);
      expect(isActiveInvocationLeaseProtected(lifecycle, BASE + 90 * 60_000)).toBe(true);
      expect(decideSandboxLifecycle({
        ...lifecycle, workloadClass: 'interactive', createdAt: iso(0), lastActiveAt: iso(0),
        nowMs: BASE + 90 * 60_000,
      })).toMatchObject({ delete: false, decision: 'retain-active' });
    }
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['unknown state', JSON.stringify({ invocationKey: 'lease-unknown', state: 'future', until: iso(1) })],
  ])('keeps %s lease residues lifecycle-busy until strict recovery clears them', (_case, raw) => {
    const lifecycle = lifecycleStateFromMetadata({}, {
      'agent-saas.kaiyan.net/active-invocation-malformed': raw,
    });
    expect(lifecycle.activeInvocationLeases).toHaveLength(1);
    expect(lifecycle.activeInvocationLeases?.[0]?.malformed).toBe(true);
    expect(lifecycle.activeInvocationLeaseRecoveryPending).toBe(true);
    expect(isActiveInvocationLeaseProtected(lifecycle, BASE + 90 * 60_000)).toBe(true);
    expect(decideSandboxLifecycle({
      ...lifecycle, workloadClass: 'interactive', createdAt: iso(0), lastActiveAt: iso(0),
      nowMs: BASE + 90 * 60_000,
    })).toMatchObject({ delete: false, decision: 'retain-active' });
  });

  it('protects active registry, invocation lease and background work through their deadlines', () => {
    expect(decision({ workloadClass: 'interactive', nowMinutes: 90, active: true })).toMatchObject({ delete: false, decision: 'retain-active' });
    expect(decision({ workloadClass: 'interactive', nowMinutes: 90, backgroundProtected: true })).toMatchObject({ delete: false, decision: 'retain-background-protected' });
    expect(decideSandboxLifecycle({
      workloadClass: 'interactive',
      createdAt: iso(0),
      lastActiveAt: iso(0),
      activeInvocationLeaseUntil: iso(120 * 60_000),
      nowMs: BASE + 90 * 60_000,
    })).toMatchObject({ delete: false, decision: 'retain-active' });
  });
});

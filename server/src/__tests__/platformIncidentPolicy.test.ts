import { describe, expect, it, vi } from 'vitest';

import {
  buildRunSystemIncidents,
  buildRunSystemIncidentsFromSnapshot,
  platformRecoveryItem,
  selectAttentionSystemIncidents,
  selectExternalSystemIncidents,
} from '../runtime/platformIncidentPolicy.js';

describe('platformIncidentPolicy', () => {
  it('only promotes critical root disk pressure from the routine attention queue', () => {
    expect(selectAttentionSystemIncidents([
      { kind: 'failed_run', severity: 'high', title: 'single run failed' },
      { kind: 'disk_root_high', severity: 'high', title: 'root 85%' },
      { kind: 'disk_root_high', severity: 'critical', title: 'root 93%' },
      { kind: 'tls_cert_expiring', severity: 'critical', title: 'TLS 3 days' },
    ])).toEqual([
      { kind: 'disk_root_high', severity: 'critical', title: 'root 93%' },
    ]);
  });

  it('suppresses billing and medium ACS events while keeping ACS capacity/lifecycle failures', () => {
    expect(selectExternalSystemIncidents('billing_audit', [
      { kind: 'billing_audit', severity: 'high', title: 'margin low' },
    ])).toEqual([]);
    expect(selectExternalSystemIncidents('test', [
      { kind: 'failed_run', severity: 'high', title: 'bypass attempt' },
    ])).toEqual([]);
    expect(selectExternalSystemIncidents('fake-acs-orchestrator-proxy', [
      { kind: 'acs_sandbox_lifecycle_failed', severity: 'high', title: 'spoofed source' },
    ])).toEqual([]);
    expect(selectExternalSystemIncidents('agent-saas-acs-orchestrator', [
      { kind: 'acs_sandbox_stale_image_prewarm', severity: 'medium', title: 'prewarm failed' },
      { kind: 'acs_sandbox_running_near_quota', severity: 'high', title: 'capacity exhausted' },
      { kind: 'acs_sandbox_allocated_near_quota', severity: 'high', title: 'weighted capacity exhausted' },
      { kind: 'acs_sandbox_lifecycle_failed', severity: 'high', title: 'lifecycle failed' },
    ])).toEqual([
      { kind: 'acs_sandbox_running_near_quota', severity: 'high', title: 'capacity exhausted' },
      { kind: 'acs_sandbox_allocated_near_quota', severity: 'high', title: 'weighted capacity exhausted' },
      { kind: 'acs_sandbox_lifecycle_failed', severity: 'high', title: 'lifecycle failed' },
    ]);
  });

  it('requires a cross-user sustained failure spike instead of individual failed runs', () => {
    expect(buildRunSystemIncidentsFromSnapshot({
      recentTotal: 10,
      recentFailed: 8,
      failedUsers: 1,
      stalledPending: 0,
      stalledUsers: 0,
    })).toEqual([]);

    expect(buildRunSystemIncidentsFromSnapshot({
      recentTotal: 10,
      recentFailed: 6,
      failedUsers: 3,
      stalledPending: 0,
      stalledUsers: 0,
    })).toEqual([
      expect.objectContaining({ kind: 'platform_run_failure_spike', severity: 'high' }),
    ]);
  });

  it('requires pending backlog to affect multiple users before declaring a queue incident', () => {
    expect(buildRunSystemIncidentsFromSnapshot({
      recentTotal: 0,
      recentFailed: 0,
      failedUsers: 0,
      stalledPending: 12,
      stalledUsers: 1,
    })).toEqual([]);

    expect(buildRunSystemIncidentsFromSnapshot({
      recentTotal: 0,
      recentFailed: 0,
      failedUsers: 0,
      stalledPending: 3,
      stalledUsers: 2,
    })).toEqual([
      expect.objectContaining({ kind: 'platform_run_queue_stalled', severity: 'high' }),
    ]);
  });

  it('queries terminal failures and pending backlog from the run store', async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{ recent_total: '9', recent_failed: '5', failed_users: '2', stalled_pending: '0', stalled_users: '0' }],
    }));
    const items = await buildRunSystemIncidents({ pool: { query }, runsTable: 'runtime_runs' } as any);

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]![0])).toContain("status = 'pending'");
    expect(String(query.mock.calls[0]![0])).toContain('completed_at >=');
    expect(String(query.mock.calls[0]![0])).toContain('failed_at >=');
    expect(items).toEqual([
      expect.objectContaining({ kind: 'platform_run_failure_spike', severity: 'high' }),
    ]);
  });

  it('builds explicit recovery messages for recoverable incidents', () => {
    expect(platformRecoveryItem('platform_run_failure_spike')).toMatchObject({
      kind: 'platform_run_failure_spike_recovered',
      severity: 'info',
    });
    expect(platformRecoveryItem('platform_run_queue_stalled')).toMatchObject({
      kind: 'platform_run_queue_stalled_recovered',
      severity: 'info',
    });
  });
});

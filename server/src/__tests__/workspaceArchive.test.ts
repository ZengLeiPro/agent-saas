import { describe, expect, it } from 'vitest';

import { canArchiveWorkspaceStatus, canDeleteWorkspaceStatus, isWorkspaceScanFresh, resolveWorkspacePath } from '../runtime/workspaceArchive.js';

describe('workspace archive guards', () => {
  it('rejects absolute and escaping paths', () => {
    expect(() => resolveWorkspacePath('/tmp/workspaces', '/tmp/workspaces/a')).toThrow(/Invalid workspace path/);
    expect(() => resolveWorkspacePath('/tmp/workspaces', '../etc')).toThrow(/outside agent cwd/);
  });

  it('allows relative paths inside agent cwd', () => {
    expect(resolveWorkspacePath('/tmp/workspaces', 'kaiyan/ky123').relativePath).toBe('kaiyan/ky123');
  });

  it('only allows non-active workspace statuses', () => {
    expect(canArchiveWorkspaceStatus('active')).toBe(false);
    expect(canArchiveWorkspaceStatus('soft_deleted')).toBe(true);
    expect(canArchiveWorkspaceStatus('orphan_tenant')).toBe(true);
    expect(canArchiveWorkspaceStatus('orphan_user')).toBe(true);
    expect(canDeleteWorkspaceStatus('active')).toBe(false);
    expect(canDeleteWorkspaceStatus('soft_deleted')).toBe(true);
    expect(canDeleteWorkspaceStatus('orphan_tenant')).toBe(true);
    expect(canDeleteWorkspaceStatus('orphan_user')).toBe(true);
  });

  it('checks scan freshness', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    expect(isWorkspaceScanFresh('2026-07-07T00:00:00.000Z', now)).toBe(true);
    expect(isWorkspaceScanFresh('2026-07-05T00:00:00.000Z', now)).toBe(false);
  });
});

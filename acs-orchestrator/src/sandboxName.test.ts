import { describe, expect, it } from 'vitest';

import { sandboxNameFor, validateSessionId, validateWorkspaceId } from './sandboxName.js';

describe('sandboxNameFor', () => {
  it('builds a stable Kubernetes-safe name from workspace scope', () => {
    const name = sandboxNameFor({
      workspaceId: 'ws_kaiyan__ky50wfyptpafch',
      sessionId: '4d9d88c9-da74-4982-800c-9559f6f65bac',
    });
    expect(name).toMatch(/^as-[a-z0-9-]+-[a-f0-9]{16}$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toBe(sandboxNameFor({
      workspaceId: 'ws_kaiyan__ky50wfyptpafch',
      sessionId: '4d9d88c9-da74-4982-800c-9559f6f65bac',
    }));
    expect(name).toBe(sandboxNameFor({
      workspaceId: 'ws_kaiyan__ky50wfyptpafch',
      sessionId: 'different-session',
    }));
    expect(name).not.toBe(sandboxNameFor({
      workspaceId: 'ws_kaiyan__other-user',
      sessionId: '4d9d88c9-da74-4982-800c-9559f6f65bac',
    }));
  });

  it('rejects path-like workspace and session ids', () => {
    expect(() => validateWorkspaceId('../x')).toThrow(/非法/);
    expect(() => validateWorkspaceId('.archive')).toThrow(/非法/);
    expect(() => validateSessionId('a/b')).toThrow(/非法/);
  });
});

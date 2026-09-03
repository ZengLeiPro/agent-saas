import { describe, expect, it } from 'vitest';

import type { Kubectl, KubectlResult } from './kubectl.js';
import { SandboxManager } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

describe('Sandbox create-only concurrency fence', () => {
  it('fails closed when another instance creates the same CR instead of applying over it', async () => {
    let sandboxApplyCount = 0;
    let sandboxCreateCount = 0;
    const kubectl = {
      async run(args: string[], options: { input?: string } = {}): Promise<KubectlResult> {
        if (args[0] === 'get' && args.includes('-l')) {
          return { stdout: '{"items":[]}', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'get') return { stdout: '', stderr: 'NotFound', exitCode: 1, signal: null };
        if (args[0] === 'apply') {
          const manifest = JSON.parse(options.input ?? '{}') as { kind?: string };
          if (manifest.kind === 'Sandbox') sandboxApplyCount += 1;
          return { stdout: '', stderr: '', exitCode: 0, signal: null };
        }
        if (args[0] === 'create') {
          sandboxCreateCount += 1;
          return { stdout: '', stderr: 'AlreadyExists', exitCode: 1, signal: null };
        }
        throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
      },
    } as unknown as Kubectl;
    const manager = new SandboxManager(baseConfig(), kubectl, noopLogger);

    await expect(manager.ensureRunning({ workspaceId: 'ws-create-race', sessionId: 's-1' }))
      .rejects.toThrow(/拒绝覆盖并发创建/u);
    expect(sandboxCreateCount).toBe(1);
    expect(sandboxApplyCount).toBe(0);
  });
});

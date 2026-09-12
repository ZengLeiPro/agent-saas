import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { initializeRuntimeEgress } from '../app/runtimeEgressAssembly.js';
import { EgressConfigStore } from '../data/egressConfig.js';
import type { EgressConfig } from '../runtime/egressPolicy.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('runtime egress assembly', () => {
  it('runtime worker refreshes a server-process domain update before routing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-egress-'));
    roots.push(root);
    const runtime = initializeRuntimeEgress({
      processCwd: root,
      config: parseAppConfig({ agent: { cwd: root }, server: { port: 3200 } }),
    });
    const writer = new EgressConfigStore(join(root, 'data', 'egress-config.json'));
    const config: EgressConfig = {
      server: {
        enabled: true,
        proxyUrl: 'http://127.0.0.1:7890',
        matchDomains: ['x.ai', 'grok.com'],
        bypassDomains: [],
        timeoutMs: 20_000,
        failOpen: true,
      },
      sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: {
        enabled: false,
        pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
        pipTrustedHost: 'mirrors.aliyun.com',
        npmRegistry: 'https://registry.npmmirror.com',
      },
    };

    await writer.update(config, { actor: 'server-process' });
    await runtime.egressDispatchers.refresh();

    expect(runtime.egressConfigStore.getConfigVersion()).toBe(1);
    expect(
      runtime.egressDispatchers.resolve('https://cli-chat-proxy.grok.com/v1/responses').dispatcher,
    ).not.toBeNull();
    runtime.restoreGlobalEgressFetch();
    await runtime.egressDispatchers.close();
  });
});

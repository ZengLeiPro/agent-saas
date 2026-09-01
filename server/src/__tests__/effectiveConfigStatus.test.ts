import { describe, expect, it } from 'vitest';

import { buildEffectiveConfigStatus } from '../config/effectiveConfigStatus.js';

describe('effective config status', () => {
  it('exposes stable fingerprints and readiness without returning secret material', () => {
    const config = {
      agent: { cwd: '/tmp/workspace', permissionMode: 'default', maxTurns: 20 },
      server: { port: 3000 },
      models: {
        default: 'g/m',
        allowCrossGroupSwitch: false,
        groups: [
          {
            id: 'g',
            name: 'G',
            apiKey: 'must-not-leak',
            models: [{ id: 'm', name: 'M', value: 'm' }],
          },
        ],
      },
      webTools: { enabled: true, search: { provider: 'brave', apiKeyRef: 'vault/secret-ref' } },
      stt: { enabled: false, apiKeyRef: '' },
      dingtalk: { robots: [{ appSecret: 'must-also-not-leak' }] },
    } as never;
    const status = buildEffectiveConfigStatus({
      config,
      environment: 'staging',
      processRole: 'ws-only',
      appliedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(status.effectiveConfigFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(status.capabilityFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(status.secretReadiness).toBe('missing');
    expect(status.secrets).toEqual({
      references: 1,
      inlineLegacy: 2,
      missing: 1,
      items: [
        { path: 'dingtalk.robots[0].appSecret', status: 'legacy_inline', target: null },
        { path: 'models.groups[0].apiKey', status: 'legacy_inline', target: 'models' },
        { path: 'stt.apiKeyRef', status: 'missing', target: 'tools' },
        { path: 'webTools.search.apiKeyRef', status: 'reference', target: 'tools' },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('must-not-leak');
    expect(JSON.stringify(status)).not.toContain('must-also-not-leak');
    expect(JSON.stringify(status)).not.toContain('vault/secret-ref');
  });
});

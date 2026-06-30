import { afterEach, describe, expect, it } from 'vitest';

import { loadConfigFromEnv } from './config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfigFromEnv', () => {
  it('defaults to loopback for standalone safety', () => {
    process.env.HAND_SERVER_AUTH_TOKEN = 'token-1234';
    delete process.env.HAND_SERVER_HOST;

    expect(loadConfigFromEnv().host).toBe('127.0.0.1');
  });

  it('accepts HAND_SERVER_HOST for Docker bridge / tenant ECS deployments', () => {
    process.env.HAND_SERVER_AUTH_TOKEN = 'token-1234';
    process.env.HAND_SERVER_HOST = '0.0.0.0';

    expect(loadConfigFromEnv().host).toBe('0.0.0.0');
  });

  it('parses container hardening and workspace ownership env vars', () => {
    process.env.HAND_SERVER_AUTH_TOKEN = 'token-1234';
    process.env.HAND_CONTAINER_IMAGE = 'agent-saas-node:local';
    process.env.HAND_CONTAINER_USER = '1000:1000';
    process.env.HAND_CONTAINER_MEMORY = '768m';
    process.env.HAND_CONTAINER_CPUS = '0.5';
    process.env.HAND_CONTAINER_PIDS_LIMIT = '128';
    process.env.HAND_CONTAINER_READ_ONLY = 'true';
    process.env.HAND_CONTAINER_TMPFS = '/tmp:rw,size=32m;/run:rw,size=8m';
    process.env.HAND_CONTAINER_CAP_DROP = 'ALL';
    process.env.HAND_CONTAINER_SECURITY_OPT = 'no-new-privileges';
    process.env.HAND_WORKSPACE_UID = '1000';
    process.env.HAND_WORKSPACE_GID = '1000';
    process.env.HAND_WORKSPACE_MODE = '0770';

    expect(loadConfigFromEnv()).toMatchObject({
      workspace: { uid: 1000, gid: 1000, mode: 0o770 },
      container: {
        image: 'agent-saas-node:local',
        user: '1000:1000',
        memory: '768m',
        cpus: '0.5',
        pidsLimit: 128,
        readOnly: true,
        tmpfs: ['/tmp:rw,size=32m', '/run:rw,size=8m'],
        capDrop: ['ALL'],
        securityOpt: ['no-new-privileges'],
      },
    });
  });

  it('defaults Docker hand network policy to isolated and parses explicit desired policy', () => {
    process.env.HAND_SERVER_AUTH_TOKEN = 'token-1234';
    expect(loadConfigFromEnv().networkPolicy).toEqual({
      mode: 'isolated',
      denyPrivateNetworks: true,
    });

    process.env.HAND_NETWORK_POLICY_MODE = 'private-egress';
    process.env.HAND_NETWORK_POLICY_ALLOW_CIDRS = '10.8.0.0/16';
    process.env.HAND_NETWORK_POLICY_DENY_CIDRS = '100.100.100.200/32';
    expect(loadConfigFromEnv().networkPolicy).toEqual({
      mode: 'private-egress',
      denyPrivateNetworks: true,
      allowCidrs: ['10.8.0.0/16'],
      denyCidrs: ['100.100.100.200/32'],
    });
  });
});

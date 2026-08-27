#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function renderStagingConfig(source, env = process.env) {
  const config = structuredClone(source);
  const jwtSecret = required(env, 'STAGING_JWT_SECRET');
  const databaseUrl = required(env, 'STAGING_DATABASE_URL');

  config.agent = {
    ...(config.agent ?? {}),
    cwd: '/mnt/agent-saas-staging/workspaces',
    sharedDir: '/mnt/agent-saas-staging/workspace-shared',
    userOverrides: {},
  };
  config.server = {
    ...(config.server ?? {}),
    port: 3210,
    corsOrigins: ['https://staging-agent.kaiyan.net'],
    webBaseUrl: 'https://staging-agent.kaiyan.net',
  };
  config.cron = {
    enabled: false,
    store: '/mnt/agent-saas-staging/runtime/server/data/cron-jobs.json',
  };
  config.auth = {
    ...(config.auth ?? {}),
    enabled: true,
    jwtSecret,
    usersFile: '/mnt/agent-saas-staging/runtime/server/data/users.json',
    selfSignup: { ...(config.auth?.selfSignup ?? {}), enabled: false },
  };
  delete config.auth.selfSignup.dingtalkLeadWebhook;
  delete config.auth.selfSignup.sms;

  config.dingtalk = { enabled: false, robots: {} };
  config.dingtalkSendMessage = { enabled: false };
  config.webPush = { enabled: false };
  config.alerting = { enabled: false };
  config.codexSubscription = { enabled: false, websocketEnabled: false };
  config.webTools = { enabled: false };
  config.imageGenTools = { enabled: false };
  config.toolControls = { ...(config.toolControls ?? {}), enabled: true };
  config.serverRemote = undefined;
  config.tenantRemoteHands = {
    hands: [
      {
        id: 'agent-saas-staging-acs',
        description: 'Isolated Staging ACS coding runtime',
        baseUrl: 'http://127.0.0.1:3410',
        authTokenRef: 'STAGING_AGENT_SAAS/acs-token',
        invokeTimeoutMs: 600_000,
        rollout: { mode: 'all' },
        networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      },
    ],
  };
  config.runtimeEventStore = {
    backend: 'pg',
    connectionString: databaseUrl,
    tablePrefix: 'staging_runtime',
    poolMax: 10,
  };
  config.runtimeScheduler = {
    ...(config.runtimeScheduler ?? {}),
    autoWake: true,
    maxConcurrentRuns: 10,
    foregroundReservedRuns: 2,
    maxConfigurableConcurrentRuns: 10,
  };
  config.secretVault = {
    backend: 'encrypted-file',
    filePath: '/mnt/agent-saas-staging/runtime/vault/secrets.enc',
    encryptionKeyEnv: 'STAGING_AGENT_SAAS_VAULT_KEY',
  };
  config.egress = {
    server: {
      enabled: true,
      proxyUrl: 'http://127.0.0.1:3128',
      matchDomains: [],
      bypassDomains: [],
      timeoutMs: 20_000,
      failOpen: false,
    },
    sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
    packageMirrors: {
      enabled: false,
      pipIndexUrl: '',
      pipTrustedHost: '',
      npmRegistry: '',
    },
  };

  for (const key of ['integrationV3', 'notification', 'notifications']) delete config[key];
  return JSON.parse(JSON.stringify(config));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath) {
    throw new Error('usage: render-config.mjs <source-config.json> <output-config.json>');
  }
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const rendered = renderStagingConfig(source);
  await writeFile(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

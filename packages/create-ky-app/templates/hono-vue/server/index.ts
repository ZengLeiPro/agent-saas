#!/usr/bin/env node
/** 进程入口：读配置 → 建库 → 装配 → 起 HTTP。 */
import { serve } from '@hono/node-server';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const built = await buildApp(config);

const server = serve({ fetch: built.app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(
    `__SYSTEM_NAME__ 已启动：http://127.0.0.1:${String(info.port)}（KY_ENV=${config.ky.env}）`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await built.close();
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

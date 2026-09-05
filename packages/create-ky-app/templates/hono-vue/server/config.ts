/**
 * 部署配置。契约相关的 `KY_*` 一律交给 `@kaiyan/ky-app-server` 的 `loadKyAppConfig()`，
 * 本文件只补本项目自己的三项：数据库、端口、mock 壳 origin 与目录接口地址。
 */
import { loadKyAppConfig, type KyAppConfig } from '@kaiyan/ky-app-server';

export interface AppConfig {
  ky: KyAppConfig;
  port: number;
  databaseUrl: string;
  /** 组织目录接口基址（§3.6）。 */
  directoryUrl: string;
  /**
   * 本地 mock 壳的 origin。只在 `KY_ENV ∈ local|test` 下生效：把它加进
   * CSP 的 `frame-ancestors`，否则本地壳的跨源 iframe 加载不了（§5.1）。
   */
  shellOrigin?: string;
}

function requireEnv(name: 'DATABASE_URL'): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少必填环境变量 ${name}`);
  }
  return value.trim();
}

/** `--port` 优先于 `PORT`，都没有则 8787。 */
export function resolvePort(argv: string[] = process.argv.slice(2)): number {
  const index = argv.indexOf('--port');
  const inline = argv.find((item) => item.startsWith('--port='));
  const raw =
    index >= 0 && index + 1 < argv.length
      ? argv[index + 1]
      : inline !== undefined
        ? inline.slice('--port='.length)
        : process.env.PORT;
  const port = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(port) && port > 0 ? port : 8787;
}

export function loadConfig(argv?: string[]): AppConfig {
  const ky = loadKyAppConfig();
  const shellOrigin = process.env.KY_SHELL_ORIGIN;
  const directoryUrl = process.env.KY_DIRECTORY_URL;
  return {
    ky,
    port: resolvePort(argv),
    databaseUrl: requireEnv('DATABASE_URL'),
    directoryUrl: directoryUrl ?? 'https://api.agent.kaiyan.net',
    // 生产环境一律忽略这个变量，避免有人把壳白名单放开到别处。
    ...(shellOrigin !== undefined && shellOrigin !== '' && (ky.env === 'local' || ky.env === 'test')
      ? { shellOrigin }
      : {}),
  };
}

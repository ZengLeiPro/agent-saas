/**
 * Wire env filter —— brain 与远端 hand 之间显式透传的运行态环境变量边界。
 *
 * 能力中心连接器的凭据由 brain 从 Vault 解析后放入单次 Run 上下文。远端 hand
 * 必须接收这些标准 env，不能再为每个连接器维护静态名单；否则新增连接器会出现
 * 本地可用、远端失效的隐性分叉。
 *
 * 这里允许标准大写 env 名，但拒绝能改变进程加载、模块解析或代理行为的保留变量。
 * 外部请求不能直接提交 Run env；服务端反序列化仍会再次调用本过滤器。
 */

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** 向后兼容：历史固定变量仍明确列出，但实际允许范围由 isHandEnvAllowed 判定。 */
export const HAND_ENV_ALLOWLIST: readonly string[] = [
  'AZEROTH_TOKEN',
  'AZEROTH_API_URL',
] as const;

export const HAND_ENV_DENYLIST: readonly string[] = [
  'BASH_ENV',
  'ENV',
  'HOME',
  'IFS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'RUBYOPT',
  'SHELLOPTS',
] as const;

const HAND_ENV_DENYLIST_SET = new Set<string>(HAND_ENV_DENYLIST);

export function pickHandEnv(
  env: Record<string, string | undefined> | undefined | null,
): Record<string, string> {
  if (!env) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isHandEnvAllowed(key) || typeof value !== 'string') continue;
    if (value.length === 0) {
      // Git 需要空 credential.helper 显式清除 system/global/local 继承值。
      // 只放行这一种控制值，连接器 secret 的空字符串仍会被剔除。
      const match = /^GIT_CONFIG_VALUE_(\d+)$/.exec(key);
      if (!match || env[`GIT_CONFIG_KEY_${match[1]}`] !== 'credential.helper') continue;
    }
    result[key] = value;
  }
  return result;
}

export function isHandEnvAllowed(key: string): boolean {
  return ENV_NAME_RE.test(key) && !HAND_ENV_DENYLIST_SET.has(key);
}

/**
 * Wire env allowlist —— brain（agent-saas server）与远端 hand（acs-orchestrator /
 * hand-server）之间通过 wire.context.env 显式透传的 env 变量白名单。
 *
 * 背景（07-05）：
 *   tenantRemoteHands.rollout=all 生效后，所有租户走 ACS Sandbox（远端 pod）路径。
 *   dispatch.ts:603 按 (tenantId, username) 查 tokens.json 得到的 AZEROTH_TOKEN
 *   只塞进本地 SDK spawn 的 effectiveOptions.env，**wire 协议不带 env** →
 *   远端 pod 里 `env | grep AZEROTH` 恒为空 → ky-data-query skill 拿不到 PAT。
 *   见 memory/topics/tech-agent-saas-debug.md 相关章节。
 *
 * 设计原则：
 *   - **只允许显式命名的 env 上 wire**：任何 *_TOKEN / *_KEY / *_SECRET 通配都拒；
 *     必须逐一登记，防止上游误把 API key 塞进 wire 泄给 pod 内子进程 / 外泄。
 *   - **服务端（hand-server / acs-orchestrator）二次过滤**（防御纵深）：
 *     即使 client 传了 allowlist 之外的 key，服务端 parseWireRequest 也会剥掉。
 *   - 当前只覆盖 ky-azeroth CLI 的两个 env；未来加新 env 时同步 client + server 两侧
 *     (server/src/runtime/handEnvAllowlist.ts 与 acs-orchestrator/src/protocol.ts 里
 *     的 pickHandEnv 引用要保持一致 —— 后者从本文件导入)。
 *
 * 反面禁止事项：
 *   - GH_TOKEN / GITHUB_TOKEN：dispatch.ts 明确不注入远端沙箱（走 credential.helper
 *     调 host-side gh auth token），本 allowlist 也不加。
 *   - ANTHROPIC_API_KEY / OPENAI_API_KEY / DASHSCOPE_API_KEY 等模型 key：这些从
 *     config.dispatch.env 走远端 pod K8s spec 层（sandboxManager.ts），不经 wire。
 */

export const HAND_ENV_ALLOWLIST: readonly string[] = [
  'AZEROTH_TOKEN',
  'AZEROTH_API_URL',
] as const;

const HAND_ENV_ALLOWLIST_SET = new Set<string>(HAND_ENV_ALLOWLIST);

/**
 * 从任意 env 对象里挑出 allowlist 内的 key。undefined/空值全部剔除。
 * client（brain）序列化 wireRequest 前用，server（hand）反序列化后也用（防御纵深）。
 */
export function pickHandEnv(
  env: Record<string, string | undefined> | undefined | null,
): Record<string, string> {
  if (!env) return {};
  const result: Record<string, string> = {};
  for (const key of HAND_ENV_ALLOWLIST) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) {
      result[key] = v;
    }
  }
  return result;
}

/** 判定某个 key 是否在 wire env allowlist 内。给测试与 debug 用。 */
export function isHandEnvAllowed(key: string): boolean {
  return HAND_ENV_ALLOWLIST_SET.has(key);
}

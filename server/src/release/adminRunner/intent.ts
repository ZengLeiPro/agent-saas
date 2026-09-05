/**
 * 写意图识别与 allowlist 参数摘要。
 *
 * 只按 manifest 声明的 flag **精确**识别（7 个脚本都用 `argv.includes('--flag')` /
 * `arg === '--flag'` 精确匹配，`--execute=false` 对脚本而言不是写 flag，launcher 也不能
 * 把它算成写）。没有出现任何写 flag 就是脚本自身的默认模式（read_only / dry_run），
 * 因此“遗漏参数”不可能被识别成写模式。
 *
 * 参数摘要是真正的 allowlist：只记录 manifest 声明过的 flag 名，其余参数一律只计数，
 * 值与未声明的名字永不落盘（连接串、租户 ID、路径、伪装成 flag 的原文都进不了回执）。
 */
import type { CommandGovernance } from './manifest.js';

export type ExecutionMode = 'read_only' | 'dry_run' | 'write';

export type IntentProblem =
  | { category: 'escalation_without_write'; flag: string; requiresWriteIntent: string }
  | { category: 'authorization_ref_misplaced'; flag: string };

export interface ArgsSummary {
  /** 仅 manifest 声明的写 flag / 升级 flag 中实际出现的，排序去重。 */
  declaredFlags: string[];
  /** 其它以 `--` 开头的参数数量（名字不记录）。 */
  otherFlagCount: number;
  /** 非 `--` 开头的参数数量（位置参数或独立值）。 */
  positionalCount: number;
  /** 以 `--name=value` 形态携带值的参数数量。 */
  inlineValueCount: number;
}

export interface InvocationClassification {
  mode: ExecutionMode;
  writeIntents: string[];
  escalationFlags: string[];
  problems: IntentProblem[];
  argsSummary: ArgsSummary;
}

export const AUTHORIZATION_REF_FLAG = '--authorization-ref';

export function summarizeArgs(
  args: readonly string[],
  declared: ReadonlySet<string> = new Set(),
): ArgsSummary {
  const declaredFlags = new Set<string>();
  let otherFlagCount = 0;
  let positionalCount = 0;
  let inlineValueCount = 0;
  for (const argument of args) {
    if (!argument.startsWith('--') || argument === '--') {
      positionalCount += 1;
      continue;
    }
    if (argument.includes('=')) inlineValueCount += 1;
    if (declared.has(argument)) declaredFlags.add(argument);
    else otherFlagCount += 1;
  }
  return {
    declaredFlags: [...declaredFlags].sort(),
    otherFlagCount,
    positionalCount,
    inlineValueCount,
  };
}

export function classifyInvocation(
  governance: CommandGovernance,
  scriptArgs: readonly string[],
): InvocationClassification {
  const present = new Set(scriptArgs);
  const declared = new Set([
    ...governance.writeIntents.map((intent) => intent.flag),
    ...governance.escalationFlags.map((escalation) => escalation.flag),
  ]);
  const argsSummary = summarizeArgs(scriptArgs, declared);
  const writeIntents = governance.writeIntents
    .map((intent) => intent.flag)
    .filter((flag) => present.has(flag));
  const problems: IntentProblem[] = [];
  const escalationFlags: string[] = [];
  for (const escalation of governance.escalationFlags) {
    if (!present.has(escalation.flag)) continue;
    escalationFlags.push(escalation.flag);
    if (!present.has(escalation.requiresWriteIntent)) {
      problems.push({
        category: 'escalation_without_write',
        flag: escalation.flag,
        requiresWriteIntent: escalation.requiresWriteIntent,
      });
    }
  }
  // --authorization-ref 由 launcher 持有；脚本参数里出现（含 =value 形态）即拒绝。
  if (
    scriptArgs.some(
      (argument) =>
        argument === AUTHORIZATION_REF_FLAG || argument.startsWith(`${AUTHORIZATION_REF_FLAG}=`),
    )
  ) {
    problems.push({ category: 'authorization_ref_misplaced', flag: AUTHORIZATION_REF_FLAG });
  }
  const mode: ExecutionMode = writeIntents.length > 0 ? 'write' : governance.defaultMode;
  return { mode, writeIntents, escalationFlags, problems, argsSummary };
}

/** 工单/审批单号：字母数字与 . _ # -，不含 / 与 :，避免 URL、连接串或路径伪装成单号进入回执。 */
export const AUTHORIZATION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#-]{0,63}$/u;
/** 形态像 token 的“单号”直接拒绝，而不是等回执脱敏扫描把整份回执拒写。 */
const CREDENTIAL_SHAPED_REF = /^(?:sk|ghp|gho|ghs|ghu|xox[abps]|glpat|AKIA)[-_A-Za-z0-9]{8,}$/u;

export function normalizeAuthorizationRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!AUTHORIZATION_REF_PATTERN.test(trimmed) || CREDENTIAL_SHAPED_REF.test(trimmed)) {
    throw new Error(
      `${AUTHORIZATION_REF_FLAG} must be a ticket/approval reference (letters, digits, . _ # -, max 64 chars, not a token)`,
    );
  }
  return trimmed;
}

/** 必填 flag 缺失清单（精确名或 `--flag=value` 形态都算出现）。 */
export function missingRequiredFlags(
  governance: CommandGovernance,
  scriptArgs: readonly string[],
): string[] {
  return governance.requiredFlags.filter(
    (flag) => !scriptArgs.some((argument) => argument === flag || argument.startsWith(`${flag}=`)),
  );
}

/**
 * 目标覆盖信号：这些参数/环境变量会让脚本读写 Config Identity 之外的目标（另一库、另一目录）。
 * 回执只记录“出现了哪一个信号名”，不记录值；它提醒复核者“配置身份一致 ≠ 实际目标一致”。
 */
export const TARGET_OVERRIDE_FLAGS = [
  '--connection-string',
  '--root',
  '--data-dir',
  '--config-dir',
  '--workspace-shared',
  '--table-prefix',
  '--cwd',
] as const;
export const TARGET_OVERRIDE_ENV = ['DATABASE_URL', 'AGENT_TRANSCRIPTS_ROOT'] as const;

export function detectTargetOverrides(
  env: NodeJS.ProcessEnv,
  scriptArgs: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const flag of TARGET_OVERRIDE_FLAGS) {
    if (scriptArgs.some((argument) => argument === flag || argument.startsWith(`${flag}=`))) {
      found.add(flag);
    }
  }
  for (const name of TARGET_OVERRIDE_ENV) {
    if (env[name]?.trim()) found.add(`env:${name}`);
  }
  return [...found].sort();
}

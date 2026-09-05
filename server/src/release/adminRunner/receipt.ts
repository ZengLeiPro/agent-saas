/**
 * Admin Runner 执行回执（schemaVersion 1）：版本化、脱敏、原子写入。
 *
 * 回执只记录 launcher 自己能确证的事实：命令与 digest、Release/Config identity、环境、
 * 模式、allowlist 参数摘要、目标覆盖信号名、actor（来源 + 明确 trusted=false）、时间、结果、
 * 退出码与错误类别。不记录参数值、连接串、token、配置明文、SQL、文件正文或任何绝对路径。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { ConfigIdentityCheck } from './configIdentityCheck.js';
import type { ArgsSummary, ExecutionMode } from './intent.js';
import type { DefaultMode, RiskLevel } from './manifest.js';
import type { ReleaseIdentityCheck } from './releaseIdentity.js';

export const ADMIN_RECEIPT_SCHEMA_VERSION = 1 as const;
export const ADMIN_RECEIPT_KIND = 'agent-saas-admin-runner-receipt' as const;

export type ReceiptResult = 'started' | 'succeeded' | 'failed' | 'rejected' | 'cancelled';

export type ReceiptErrorCategory =
  | 'invalid_arguments'
  | 'unknown_command'
  | 'manifest_invalid'
  | 'entry_tampered'
  | 'environment_unidentified'
  | 'environment_unsupported'
  | 'release_identity_missing'
  | 'release_identity_mismatch'
  | 'config_identity_drifted'
  | 'config_identity_unverifiable'
  | 'write_flag_without_authorization'
  | 'authorization_ref_invalid'
  | 'authorization_ref_misplaced'
  | 'escalation_without_write'
  | 'receipt_dir_unavailable'
  | 'script_spawn_failed'
  | 'script_exit_nonzero'
  | 'script_signal'
  | 'launcher_internal';

export type ConfigIdentityGate = 'passed' | 'annotated' | 'rejected' | 'skipped';

export interface ReceiptActor {
  source: 'process_env';
  user?: string;
  sudoUser?: string;
  /** 本任务没有可信身份源；SSH 手工执行的 USER/SUDO_USER 可伪造，永远为 false。 */
  trusted: false;
}

export interface AdminRunnerReceipt {
  schemaVersion: typeof ADMIN_RECEIPT_SCHEMA_VERSION;
  kind: typeof ADMIN_RECEIPT_KIND;
  invocationId: string;
  /** manifest 命令名；未通过命令名格式校验的原文不落盘，记 `(invalid)`。 */
  command: string;
  entry?: string;
  entryDigest?: string;
  launcherDigest?: string;
  environment: string;
  release?: ReleaseIdentityCheck;
  configIdentity?: ConfigIdentityCheck & { gate: ConfigIdentityGate };
  mode?: ExecutionMode;
  defaultMode?: DefaultMode;
  riskLevel?: RiskLevel;
  writeIntents: string[];
  escalationFlags: string[];
  argsSummary: ArgsSummary;
  /** 出现的目标覆盖信号名（见 intent.ts）；提醒“配置身份一致 ≠ 实际目标一致”。 */
  targetOverrides: string[];
  authorizationRef?: string;
  authorizationForwarded: boolean;
  actor: ReceiptActor;
  startedAt: string;
  finishedAt?: string;
  result: ReceiptResult;
  exitCode?: number;
  signal?: string;
  errorCategory?: ReceiptErrorCategory;
  /** launcher 自己产生的固定文案；绝不回填子进程输出、参数原文或路径。 */
  errorDetail?: string;
}

export function newInvocationId(): string {
  return randomUUID();
}

export function actorFromEnv(env: NodeJS.ProcessEnv): ReceiptActor {
  const user = env.USER?.trim() || env.LOGNAME?.trim();
  const sudoUser = env.SUDO_USER?.trim();
  return {
    source: 'process_env',
    ...(user ? { user } : {}),
    ...(sudoUser ? { sudoUser } : {}),
    trusted: false,
  };
}

// 双保险：即便上游误把值塞进回执，明显的凭据形态也会让写入 fail closed。
const OBVIOUS_SECRET_PATTERNS = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s"/]+:[^\s"/]+@/iu, // scheme://user:pass@host
  /[a-z][a-z0-9+.-]*:\/\/[^\s"]+/iu, // 任何 URL/连接串
  /\b(?:sk|ghp|gho|ghs|ghu|xox[abps]|glpat|AKIA)[-_][A-Za-z0-9_-]{8,}/u,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/u,
  /"(?:password|secret|token|connectionString|authToken)"\s*:/iu,
];

const ABSOLUTE_PATH_PATTERN =
  /"[^"]*(?:\/(?:etc|opt|mnt|home|Users|var|run|tmp|srv|root|data|private)\/[^"]*)"/u;

export function serializeReceipt(receipt: AdminRunnerReceipt): string {
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const pattern of OBVIOUS_SECRET_PATTERNS) {
    if (pattern.test(json)) {
      throw new Error(
        'Admin Runner receipt would contain credential-shaped content; refusing to write',
      );
    }
  }
  if (ABSOLUTE_PATH_PATTERN.test(json)) {
    throw new Error(
      'Admin Runner receipt would contain an absolute filesystem path; refusing to write',
    );
  }
  return json;
}

export function receiptDateSegment(startedAt: string): string {
  return startedAt.slice(0, 10).replaceAll('-', '');
}

export function receiptRelativePath(receipt: AdminRunnerReceipt): string {
  return join(
    receipt.environment,
    receiptDateSegment(receipt.startedAt),
    `${receipt.invocationId}.json`,
  );
}

/** `child` 是否位于 `parent` 之内（含相等）。两者都应是已规范化的绝对路径。 */
export function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

export interface ReceiptFs {
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  rename: typeof rename;
  realpath: (path: string) => Promise<string>;
}

const defaultFs: ReceiptFs = { mkdir, writeFile, rename, realpath: (path) => realpath(path) };

export interface WriteReceiptOptions {
  /**
   * 密封 release 目录的真实路径。mkdir 之后对实际写入目录取 realpath 再判 containment，
   * 防止回执目录本身或其中间层是指向 release 的符号链接。
   */
  forbiddenRealRoot?: string;
}

/** 目录可能尚不存在：取最近的现存祖先的 realpath，再拼回不存在的尾段。 */
export async function realpathOfNearestExisting(
  path: string,
  realpathFn: (path: string) => Promise<string>,
): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpathFn(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(current.slice(parent.length).replace(/^[\\/]/u, ''));
      current = parent;
    }
  }
}

/** 临时文件 + rename 原子替换；同一 invocationId 的后续终态回执覆盖先前的 started 回执。 */
export async function writeReceiptAtomically(
  receiptDir: string,
  receipt: AdminRunnerReceipt,
  fs: ReceiptFs = defaultFs,
  options: WriteReceiptOptions = {},
): Promise<string> {
  const body = serializeReceipt(receipt);
  const directory = join(receiptDir, receipt.environment, receiptDateSegment(receipt.startedAt));
  const forbidden = options.forbiddenRealRoot;
  // mkdir 之前先按最近现存祖先的 realpath 判定，避免在密封树里创建任何目录；mkdir 之后再确认一次。
  if (forbidden) {
    const projected = await realpathOfNearestExisting(directory, fs.realpath);
    if (isInsideDirectory(forbidden, projected)) {
      throw new Error('receipt directory resolves inside the sealed release directory');
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const realDirectory = await fs.realpath(directory);
  if (forbidden && isInsideDirectory(forbidden, realDirectory)) {
    throw new Error('receipt directory resolves inside the sealed release directory');
  }
  const target = join(realDirectory, `${receipt.invocationId}.json`);
  const temporary = join(realDirectory, `.${receipt.invocationId}.${process.pid}.tmp`);
  await fs.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
  return target;
}

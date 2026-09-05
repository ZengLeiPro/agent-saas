/**
 * §8.4 / §9.3-14 密钥扫描：项目目录内不得有 `.env` 真值、私钥 PEM 或 `Bearer ` 字面量。
 *
 * 同一套规则被 `ky-app doctor` 的第 14 章和模板的 pre-commit 钩子共用
 * （09-04 华恒 `.env` 真值入仓不得重演）。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** 默认不进入的目录。 */
export const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.pnpm-store',
  '.turbo',
  '.vite',
];

/** 允许存在的 `.env` 样例文件名。 */
export const ENV_EXAMPLE_NAMES = ['.env.example', '.env.sample', '.env.template'];

/** 只对这些扩展名查 `Bearer ` 字面量（Markdown 文档在讲协议，豁免）。 */
export const CODE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.sql',
];

export type SecretRule = 'env_value' | 'private_key' | 'bearer_literal';

export interface SecretFinding {
  rule: SecretRule;
  /** 相对项目根的路径。 */
  file: string;
  line: number;
  message: string;
}

export interface SecretScanOptions {
  ignoredDirs?: string[];
  /** 路径包含这些片段的文件跳过 `Bearer ` 规则（测试夹具白名单）。 */
  allowBearerIn?: string[];
  /** 单文件读取上限，超过跳过（二进制 / 构建产物）。 */
  maxBytes?: number;
}

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/u;
const BEARER_PATTERN = /Bearer[ ]/u;
/** `.env` 里一行真值：`KEY=值`（值非空、不是 `${...}` 占位、不是注释）。 */
const ENV_VALUE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?!\s*$)(?!\$\{)(?!<)(.+)$/u;
/** 二进制探测：出现空字节即跳过。 */
const NUL = String.fromCharCode(0);

function extensionOf(file: string): string {
  const index = file.lastIndexOf('.');
  return index < 0 ? '' : file.slice(index);
}

function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

async function walk(root: string, dir: string, ignored: string[], files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignored.includes(entry.name)) continue;
      await walk(root, full, ignored, files);
      continue;
    }
    if (entry.isFile()) files.push(relative(root, full).split(sep).join('/'));
  }
}

/** 扫描一个目录，返回全部命中。空数组 = 干净。 */
export async function scanSecrets(
  root: string,
  options: SecretScanOptions = {},
): Promise<SecretFinding[]> {
  const ignored = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const allowBearerIn = options.allowBearerIn ?? [];
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const files: string[] = [];
  await walk(root, root, ignored, files);

  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const full = join(root, file);
    const info = await stat(full);
    if (info.size > maxBytes) continue;
    let text: string;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (text.includes(NUL)) continue;
    const lines = text.split('\n');
    const isExample = ENV_EXAMPLE_NAMES.includes(name);
    const checkBearer =
      CODE_EXTENSIONS.includes(extensionOf(name)) &&
      !allowBearerIn.some((fragment) => file.includes(fragment));

    for (const [index, line] of lines.entries()) {
      const lineNo = index + 1;
      if (PRIVATE_KEY_PATTERN.test(line)) {
        findings.push({ rule: 'private_key', file, line: lineNo, message: '出现私钥 PEM 头' });
      }
      if (isEnvFile(name) && !isExample) {
        const trimmed = line.trim();
        if (trimmed !== '' && !trimmed.startsWith('#') && ENV_VALUE_PATTERN.test(trimmed)) {
          findings.push({
            rule: 'env_value',
            file,
            line: lineNo,
            message: `${name} 里出现了真值（只允许提交 ${ENV_EXAMPLE_NAMES.join(' / ')}）`,
          });
        }
      }
      if (checkBearer && BEARER_PATTERN.test(line)) {
        findings.push({
          rule: 'bearer_literal',
          file,
          line: lineNo,
          message: '出现 `Bearer ` 字面量，令牌请交给 SDK 组装',
        });
      }
    }
  }
  return findings;
}

/** 把命中格式化成可读文本。 */
export function formatFindings(findings: SecretFinding[]): string {
  return findings
    .map(
      (finding) => `${finding.file}:${String(finding.line)} [${finding.rule}] ${finding.message}`,
    )
    .join('\n');
}

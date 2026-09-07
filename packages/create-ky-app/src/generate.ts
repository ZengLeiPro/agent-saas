/**
 * `create-ky-app` 的生成器：把 `templates/hono-vue/` 复制到目标目录并替换占位符。
 *
 * 模板里以 `_` 开头的名字在生成时改回点号前缀（`_gitignore` → `.gitignore`），
 * 这样模板文件本身不会被仓库的 `.gitignore` 吃掉。
 * `CLAUDE.md` 的契约片段由 `@kaiyan/ky-app-contract` 的
 * `renderClaudeMdContractSection()` 生成，绝不在模板里手写第二份。
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';

import { renderClaudeMdContractSection } from '@kaiyan/ky-app-contract/claude-md';

/** 模板目录里 `_xxx` → 生成后的真实文件名。 */
export const RENAMES: Readonly<Record<string, string>> = {
  _gitignore: '.gitignore',
  _npmrc: '.npmrc',
  '_env.example': '.env.example',
  _github: '.github',
  _husky: '.husky',
};

/** 需要写进 `package.json` 的契约包。 */
export const KY_PACKAGES = [
  '@kaiyan/ky-app-contract',
  '@kaiyan/ky-app-server',
  '@kaiyan/ky-app-browser',
] as const;
export const KY_DEV_PACKAGES = ['@kaiyan/ky-app-cli'] as const;

/** 默认版本号（`--link` 未给时写进生成项目的 package.json）。 */
export const DEFAULT_KY_VERSION = '^0.1.0';

export type LinkMode =
  | { kind: 'version'; version: string }
  | { kind: 'tarball'; dir: string; files: Record<string, string> }
  | { kind: 'workspace'; root: string };

export interface CreateProjectOptions {
  targetDir: string;
  systemId: string;
  name: string;
  /** tarball 目录或 workspace 绝对路径；不传则用 `^0.1.0`。 */
  link?: string;
  /** 模板目录，默认取包内的 `templates/hono-vue`。 */
  templateDir?: string;
}

export interface CreateProjectResult {
  targetDir: string;
  /** 生成的文件（相对目标目录，已排序）。 */
  files: string[];
  link: LinkMode;
}

const SYSTEM_ID_PATTERN = /^[a-z][a-z0-9-]{2,23}$/u;
/** 只对文本文件做占位替换，二进制原样复制。 */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.vue',
  '.html',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.sql',
  '.sh',
  '.example',
  '.txt',
  '',
];

function defaultTemplateDir(): string {
  // dist/generate.js → 包根/templates；src/generate.ts → 同样退两级。
  return fileURLToPath(new URL('../templates/hono-vue', import.meta.url));
}

function isTextFile(name: string): boolean {
  const index = name.lastIndexOf('.');
  return TEXT_EXTENSIONS.includes(index < 0 ? '' : name.slice(index));
}

/** `demo-erp` → `demo_erp`（用于变量名一类的场合）。 */
export function toIdentifier(systemId: string): string {
  return systemId.replaceAll('-', '_');
}

/** 判断 `--link` 指向的是 tarball 目录还是 workspace 根。 */
export async function resolveLink(link: string | undefined): Promise<LinkMode> {
  if (link === undefined) return { kind: 'version', version: DEFAULT_KY_VERSION };
  const root = resolve(link);
  const info = await stat(root).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(`--link 指向的目录不存在：${root}`);
  }
  const entries = await readdir(root);
  const tarballs = entries.filter((name) => name.endsWith('.tgz'));
  if (tarballs.length > 0) {
    const files: Record<string, string> = {};
    for (const packageName of [...KY_PACKAGES, ...KY_DEV_PACKAGES]) {
      const shortName = packageName.replace('@kaiyan/', 'kaiyan-');
      const match = tarballs.find((name) => name.startsWith(`${shortName}-`));
      if (match === undefined) {
        throw new Error(
          `${root} 里找不到 ${packageName} 的 tarball（形如 ${shortName}-0.1.0.tgz）`,
        );
      }
      files[packageName] = join(root, match);
    }
    return { kind: 'tarball', dir: root, files };
  }
  const workspacePackage = await stat(
    join(root, 'packages', 'ky-app-contract', 'package.json'),
  ).catch(() => null);
  if (workspacePackage !== null) return { kind: 'workspace', root };
  throw new Error(`--link ${root} 既没有 *.tgz，也不像 agent-saas 的 workspace 根`);
}

/** 某个契约包在生成项目里的版本写法。 */
export function specifierFor(link: LinkMode, packageName: string): string {
  switch (link.kind) {
    case 'version':
      return link.version;
    case 'tarball':
      return `file:${link.files[packageName]}`;
    case 'workspace':
      return `link:${join(link.root, 'packages', packageName.replace('@kaiyan/', ''))}`;
  }
}

async function collect(dir: string, prefix: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(join(dir, entry.name), relative, files);
    else if (entry.isFile()) files.push(relative);
  }
}

/** 把模板路径里的 `_xxx` 段改回点号前缀。 */
export function renameTemplatePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => RENAMES[segment] ?? segment)
    .join('/');
}

function substitute(text: string, options: { systemId: string; name: string }): string {
  return text
    .replaceAll('__SYSTEM_ID__', options.systemId)
    .replaceAll('__SYSTEM_NAME__', options.name)
    .replaceAll('__SYSTEM_IDENT__', toIdentifier(options.systemId));
}

/** 生成一个定制项目。 */
export async function createProject(options: CreateProjectOptions): Promise<CreateProjectResult> {
  if (!SYSTEM_ID_PATTERN.test(options.systemId)) {
    throw new Error(`--system-id 必须匹配 ${String(SYSTEM_ID_PATTERN)}，收到 ${options.systemId}`);
  }
  if (options.name.trim() === '' || options.name.length > 40) {
    throw new Error('--name 必须是 1~40 个字符');
  }

  const templateDir = options.templateDir ?? defaultTemplateDir();
  const targetDir = resolve(options.targetDir);
  const link = await resolveLink(options.link);

  const templateFiles: string[] = [];
  await collect(templateDir, '', templateFiles);
  templateFiles.sort((left, right) => left.localeCompare(right));

  const written: string[] = [];
  for (const relative of templateFiles) {
    const outputPath = renameTemplatePath(relative);
    const destination = join(targetDir, outputPath);
    await mkdir(join(destination, '..'), { recursive: true });
    if (isTextFile(basename(relative))) {
      const text = await readFile(join(templateDir, relative), 'utf8');
      await writeFile(destination, substitute(text, options), 'utf8');
    } else {
      await writeFile(destination, await readFile(join(templateDir, relative)));
    }
    written.push(outputPath);
  }

  await applyPackageJson(targetDir, options, link);
  written.push(await writePnpmWorkspace(targetDir, link));
  await writeClaudeMd(targetDir, options);
  if (!written.includes('CLAUDE.md')) written.push('CLAUDE.md');
  written.sort((left, right) => left.localeCompare(right));
  return { targetDir, files: written, link };
}

/** 写 `package.json`：名字、契约包版本写法。 */
async function applyPackageJson(
  targetDir: string,
  options: CreateProjectOptions,
  link: LinkMode,
): Promise<void> {
  const path = join(targetDir, 'package.json');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    name?: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  parsed.name = options.systemId;
  parsed.description = `${options.name} —— 开沿定制项目（KY Agent 衔接契约 v1）`;
  parsed.dependencies ??= {};
  parsed.devDependencies ??= {};
  for (const packageName of KY_PACKAGES) {
    parsed.dependencies[packageName] = specifierFor(link, packageName);
  }
  for (const packageName of KY_DEV_PACKAGES) {
    parsed.devDependencies[packageName] = specifierFor(link, packageName);
  }
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/**
 * pnpm 10 起 `overrides` 与 `onlyBuiltDependencies` 都放在 `pnpm-workspace.yaml`
 * （写在 package.json 里会被忽略并告警）。
 *
 * - `onlyBuiltDependencies`：白名单外的 postinstall 一律不执行，`esbuild` 要装平台二进制，
 *   不放行的话 `vite build` 直接起不来；
 * - `overrides`：契约包之间互相依赖（cli → server → contract），用 tarball / workspace
 *   安装时这些**传递依赖**仍写着 `0.1.0`，registry 上并不存在，必须一并改道。
 */
async function writePnpmWorkspace(targetDir: string, link: LinkMode): Promise<string> {
  const lines = [
    '# pnpm 10 的项目级设置。',
    'packages: []',
    '',
    '# 只放行确实需要的 postinstall（vite 依赖 esbuild 的平台二进制），其余一律不执行。',
    '# pnpm 11 认 allowBuilds，pnpm 10 认 onlyBuiltDependencies，两个都写上。',
    'allowBuilds:',
    '  esbuild: true',
    'onlyBuiltDependencies:',
    '  - esbuild',
  ];
  if (link.kind !== 'version') {
    lines.push('', '# 契约包用 tarball / workspace 安装，传递依赖一起改道。', 'overrides:');
    for (const packageName of [...KY_PACKAGES, ...KY_DEV_PACKAGES]) {
      lines.push(`  '${packageName}': ${specifierFor(link, packageName)}`);
    }
  }
  lines.push('');
  await writeFile(join(targetDir, 'pnpm-workspace.yaml'), lines.join('\n'), 'utf8');
  return 'pnpm-workspace.yaml';
}

/** `CLAUDE.md` = 项目说明 + contract 生成的 §9.2 契约片段。 */
async function writeClaudeMd(targetDir: string, options: CreateProjectOptions): Promise<void> {
  const header = [
    `# ${options.name}（${options.systemId}）`,
    '',
    '本文件给在这个仓库里干活的 AI 与人类工程师看。下面的「契约」一节由',
    '`@kaiyan/ky-app-contract` 生成，改动请先改契约包，再重新生成，**不要手改**。',
    '',
    '## 本地开发',
    '',
    '```bash',
    'pnpm install',
    'cp .env.example .env      # 填好本地配置；真值绝不入仓',
    'pnpm build                # 前端产物由后端托管',
    'pnpm dev                  # 起服务（默认 8787）',
    'pnpm exec ky-app mock-shell   # 另开一个终端，浏览器打开它打印的壳地址',
    'pnpm doctor               # §9.3 十六章一致性测试',
    '```',
    '',
  ].join('\n');
  const section = renderClaudeMdContractSection({ systemId: options.systemId, name: options.name });
  await writeFile(join(targetDir, 'CLAUDE.md'), `${header}${section}`, 'utf8');
}

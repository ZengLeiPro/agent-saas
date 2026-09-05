/** `create-ky-app <目标目录> --system-id <id> --name <名>` 的参数解析与输出。 */
import { parseArgs } from 'node:util';
import { relative, resolve } from 'node:path';

import { createProject, type LinkMode } from './generate.js';

export const USAGE = [
  'create-ky-app <目标目录> [选项]',
  '',
  '选项：',
  '  --system-id <id>        系统 id（小写字母开头，3~24 字符，只含小写字母/数字/短横线）',
  '  --name <名称>           系统显示名（≤ 40 字）',
  '  --link <目录>           @kaiyan/* 依赖来源：放 *.tgz 的目录（file:）或 agent-saas',
  '                          workspace 根（link:）；不给则写 ^0.1.0',
  '',
  '例：',
  '  npx create-ky-app ./demo-erp --system-id demo-erp --name "演示 ERP"',
].join('\n');

function describeLink(link: LinkMode): string {
  switch (link.kind) {
    case 'version':
      return `契约包版本 ${link.version}（从 registry 安装）`;
    case 'tarball':
      return `契约包用 file: 指向 ${link.dir} 里的 tarball`;
    case 'workspace':
      return `契约包用 link: 指向 workspace ${link.root}`;
  }
}

/** 命令入口，返回进程退出码。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'system-id': { type: 'string' },
        name: { type: 'string' },
        link: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.log(USAGE);
    return 2;
  }

  const [targetDir] = parsed.positionals;
  const systemId = parsed.values['system-id'];
  const name = parsed.values.name;
  if (typeof targetDir !== 'string' || typeof systemId !== 'string' || typeof name !== 'string') {
    console.error('缺少参数：<目标目录>、--system-id、--name 都是必填');
    console.log(USAGE);
    return 2;
  }

  try {
    const result = await createProject({
      targetDir,
      systemId,
      name,
      ...(typeof parsed.values.link === 'string' ? { link: parsed.values.link } : {}),
    });
    const shown = relative(process.cwd(), resolve(targetDir)) || '.';
    console.log(`已生成 ${String(result.files.length)} 个文件到 ${shown}`);
    console.log(describeLink(result.link));
    console.log('');
    console.log('下一步：');
    console.log(`  cd ${shown}`);
    console.log('  pnpm install');
    console.log('  cp .env.example .env   # 填好配置；真值绝不入仓');
    console.log('  pnpm build && pnpm doctor');
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

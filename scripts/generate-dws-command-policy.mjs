import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EFFECT_CODES = {
  read: 'r',
  write: 'w',
  destructive: 'd',
};

function isGenericBlockedFileFlag(name) {
  const flag = `--${name.toLowerCase()}`;
  if (/^(?:--output|--out|--output-dir|--download-dir|--file|--path|--dir|--directory)$/.test(flag))
    return true;
  if (
    /(?:^|-)(?:file|path|attachment|media|image)(?:-|$)/.test(flag) &&
    !/(?:^|-)(?:file|attachment|media|image)-ids?$/.test(flag)
  )
    return true;
  return /(?:^|-)(?:local|source-file|contents-file|template-file)(?:-|$)/.test(flag);
}

function classifyFileFlag(name, parameter) {
  if (isGenericBlockedFileFlag(name)) return undefined;
  const description = typeof parameter?.description === 'string' ? parameter.description : '';
  if (!description) return undefined;
  if (/@(?:file|文件|相对文件|工作目录)|-\s*(?:从|表示)?\s*stdin\b/i.test(description))
    return 'indirect';

  const evidence = description;
  if (
    /文件路径|本地保存路径|输出到本地文件路径|本地图片(?:文件)?路径|本地表格文件路径|本地音视频文件|文件夹绝对路径|附件文件路径|从文件读取|JSON 文件(?:[（；，。]|$)/.test(
      evidence,
    ) ||
    /filesystem path|local (?:json )?file|local (?:file|upload) input|local output path|local destination/i.test(
      evidence,
    )
  )
    return 'path';
  return undefined;
}

function usage(message) {
  if (message) console.error(message);
  console.error(
    '用法：node scripts/generate-dws-command-policy.mjs --catalog <version>=<schema.json> [--catalog ...] --output <策略文件>',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const catalogs = [];
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--catalog') {
      const value = argv[++index];
      if (!value?.includes('=')) usage('--catalog 必须是 <version>=<schema.json>');
      const separator = value.indexOf('=');
      catalogs.push({ version: value.slice(0, separator), file: value.slice(separator + 1) });
      continue;
    }
    if (arg === '--output') {
      output = argv[++index];
      continue;
    }
    usage(`未知参数：${arg}`);
  }
  if (catalogs.length === 0) usage('至少提供一个 --catalog');
  if (!output) usage('缺少 --output');
  return { catalogs, output };
}

function normalizeParameterFlagName(value) {
  if (typeof value !== 'string' || !value) throw new Error('DWS schema 参数名为空');
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`DWS schema 参数名无法安全归一化：${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeCommandPath(value) {
  if (typeof value !== 'string') throw new Error('DWS schema tool 缺少 cli_path');
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase().replace(/^\+/, ''));
  if (tokens.length < 2 || tokens.some((token) => !/^[a-z0-9][a-z0-9-]*$/.test(token))) {
    throw new Error(`DWS schema cli_path 无法安全归一化：${JSON.stringify(value)}`);
  }
  return tokens.join('.');
}

function readCatalog(spec) {
  if (!/^\d+\.\d+\.\d+$/.test(spec.version)) throw new Error(`CLI 版本格式无效：${spec.version}`);
  const schema = JSON.parse(readFileSync(resolve(spec.file), 'utf8'));
  if (schema?.kind !== 'schema' || schema?.level !== 'catalog' || !Array.isArray(schema.products)) {
    throw new Error(`${spec.file} 不是 dws schema --all catalog`);
  }
  if (typeof schema.catalog_hash !== 'string' || !schema.catalog_hash.startsWith('sha256:')) {
    throw new Error(`${spec.file} 缺少 catalog_hash`);
  }

  const commands = new Map();
  const fileFlags = new Map();
  let sourceToolCount = 0;
  for (const product of schema.products) {
    if (!Array.isArray(product.tools)) continue;
    for (const tool of product.tools) {
      sourceToolCount += 1;
      const path = normalizeCommandPath(tool.cli_path);
      const effect = EFFECT_CODES[tool.effect];
      if (!effect)
        throw new Error(`${spec.file} 的 ${path} 含未知 effect=${JSON.stringify(tool.effect)}`);
      if (!['not_required', 'user_required'].includes(tool.confirmation)) {
        throw new Error(
          `${spec.file} 的 ${path} 含未知 confirmation=${JSON.stringify(tool.confirmation)}`,
        );
      }
      if (!['low', 'medium', 'high'].includes(tool.risk)) {
        throw new Error(`${spec.file} 的 ${path} 含未知 risk=${JSON.stringify(tool.risk)}`);
      }
      if (!['available', 'unavailable'].includes(tool.availability)) {
        throw new Error(
          `${spec.file} 的 ${path} 含未知 availability=${JSON.stringify(tool.availability)}`,
        );
      }
      const sensitiveRead =
        effect === 'r' && (tool.confirmation !== 'not_required' || tool.risk !== 'low');
      const code = tool.availability === 'available' ? (sensitiveRead ? 'd' : effect) : 'u';
      const existing = commands.get(path);
      if (existing && existing !== code) {
        throw new Error(`${spec.file} 的归一化路径 ${path} 存在冲突：${existing} / ${code}`);
      }
      commands.set(path, code);

      const commandFileFlags = fileFlags.get(path) ?? new Map();
      for (const [name, parameter] of Object.entries(tool.parameters ?? {})) {
        const flagName = normalizeParameterFlagName(name);
        const mode = classifyFileFlag(flagName, parameter);
        if (!mode) continue;
        const existingMode = commandFileFlags.get(flagName);
        commandFileFlags.set(flagName, existingMode === 'path' || mode === 'path' ? 'path' : mode);
      }
      if (commandFileFlags.size > 0) fileFlags.set(path, commandFileFlags);
    }
  }
  if (sourceToolCount === 0) throw new Error(`${spec.file} 没有工具条目`);
  return {
    version: spec.version,
    catalogHash: schema.catalog_hash,
    sourceToolCount,
    commands,
    fileFlags,
  };
}

function assertUniqueCatalogVersions(catalogs) {
  const versions = new Set();
  for (const catalog of catalogs) {
    if (versions.has(catalog.version)) throw new Error(`CLI catalog 版本重复：${catalog.version}`);
    versions.add(catalog.version);
  }
}

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function tsProperty(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : tsString(value);
}

function render(catalogs) {
  const catalogRows = catalogs
    .map((catalog) =>
      [
        '  {',
        `    cliVersion: ${tsString(catalog.version)},`,
        `    catalogHash: ${tsString(catalog.catalogHash)},`,
        `    sourceToolCount: ${catalog.sourceToolCount},`,
        '  },',
      ].join('\n'),
    )
    .join('\n');
  const fileFlagRows = catalogs
    .map((catalog) => {
      const commands = [...catalog.fileFlags.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const rows = commands.map(([path, flags]) => {
        const flagRows = [...flags.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, mode]) => `${tsProperty(name)}: ${tsString(mode)}`)
          .join(', ');
        return `    ${tsString(path)}: { ${flagRows} },`;
      });
      return `  ${tsString(catalog.version)}: {\n${rows.join('\n')}\n  },`;
    })
    .join('\n');
  const policyRows = catalogs
    .map((catalog) => {
      const commands = [...catalog.commands.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return (
        `  ${tsString(catalog.version)}: {\n` +
        commands.map(([path, code]) => `    ${tsString(path)}: ${tsString(code)},`).join('\n') +
        `\n  },`
      );
    })
    .join('\n');
  return (
    `// 此文件由 scripts/generate-dws-command-policy.mjs 生成，禁止手改。\n` +
    `// 来源：每个对应 CLI 版本执行 dws schema --all --format json；升级 Dockerfile 中的 CLI 时必须同步生成。\n` +
    `// 映射：命令风险来自 effect，文件参数来自当前参数描述；冲突时采用更严格策略。\n\n` +
    `export type DwsCommandPolicyCode = 'r' | 'w' | 'd' | 'u';\n` +
    `export type DwsCommandFileFlagMode = 'path' | 'indirect';\n` +
    `export type DwsCommandFileFlagPolicy = Readonly<\n` +
    `  Record<string, Readonly<Record<string, DwsCommandFileFlagMode>>>\n` +
    `>;\n\n` +
    `export const DWS_COMMAND_POLICY_CATALOGS = [\n${catalogRows}\n] as const;\n\n` +
    `export const DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION = {\n${fileFlagRows}\n} as const satisfies Readonly<Record<string, DwsCommandFileFlagPolicy>>;\n\n` +
    `export const DWS_COMMAND_POLICY_BY_CLI_VERSION = {\n${policyRows}\n} as const satisfies Readonly<Record<string, Readonly<Record<string, DwsCommandPolicyCode>>>>;\n`
  );
}

const { catalogs: catalogArgs, output } = parseArgs(process.argv.slice(2));
const catalogs = catalogArgs
  .map(readCatalog)
  .sort((left, right) => left.version.localeCompare(right.version));
assertUniqueCatalogVersions(catalogs);
writeFileSync(resolve(output), render(catalogs));
console.log(
  JSON.stringify(
    {
      output: resolve(output),
      cliVersions: catalogs.map((catalog) => catalog.version),
      sourceTools: catalogs.reduce((sum, catalog) => sum + catalog.sourceToolCount, 0),
      generatedPathsByVersion: Object.fromEntries(
        catalogs.map((catalog) => [catalog.version, catalog.commands.size]),
      ),
      generatedFileFlagsByVersion: Object.fromEntries(
        catalogs.map((catalog) => [
          catalog.version,
          [...catalog.fileFlags.values()].reduce((sum, flags) => sum + flags.size, 0),
        ]),
      ),
    },
    null,
    2,
  ),
);

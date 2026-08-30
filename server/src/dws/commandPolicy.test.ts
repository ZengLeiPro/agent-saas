import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dwsBusinessToolDescriptor, resolveDwsBusinessRisk } from './businessToolProvider.js';
import {
  classifyDwsBusinessCommand,
  DWS_ACTIVE_CLI_VERSION,
  DWS_COMMAND_POLICY_CLI_VERSIONS,
  DwsCommandPolicyError,
} from './commandPolicy.js';
import {
  DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION,
  DWS_COMMAND_POLICY_BY_CLI_VERSION,
  DWS_COMMAND_POLICY_CATALOGS,
} from './generated/commandPolicy.js';

describe('DWS CLI 分版本 schema 命令策略', () => {
  it('固定并审计 CLI catalog 的来源与完整叶子命令集合', () => {
    expect(DWS_COMMAND_POLICY_CATALOGS).toEqual([
      {
        cliVersion: '1.0.55',
        catalogHash: 'sha256:c71b9bacfe2d73f5ad45151fada6fdc18bac69b266058a8b05647b6847c99835',
        sourceToolCount: 840,
      },
      {
        cliVersion: '1.0.60',
        catalogHash: 'sha256:3e9c74c81adbc9e3f58476121c087e93b8b9f134d043f5ef1bc329fd96faf703',
        sourceToolCount: 1256,
      },
    ]);
    expect(Object.keys(DWS_COMMAND_POLICY_BY_CLI_VERSION['1.0.55'])).toHaveLength(830);
    expect(Object.keys(DWS_COMMAND_POLICY_BY_CLI_VERSION['1.0.60'])).toHaveLength(1234);
    expect(countGeneratedFileFlags('1.0.55')).toBe(13);
    expect(countGeneratedFileFlags('1.0.60')).toBe(19);
    expect(DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION['1.0.55']).toMatchObject({
      'doc.create': { content: 'indirect' },
      'doc.update': { content: 'indirect' },
      'report.entry.submit': { contents: 'indirect' },
      'sheet.csv-put': { csv: 'indirect' },
      'sheet.range.batch-set-style': { batch: 'path' },
    });
    expect(DWS_COMMAND_POLICY_BY_CLI_VERSION['1.0.55']['mcp.url.get']).toBe('d');
    expect(DWS_COMMAND_POLICY_BY_CLI_VERSION['1.0.60']['devapp.credentials-get']).toBe('d');
  });

  it('TASK-335 复现的五条当前查询不再触发授权，跨版本快捷命令保持 fail-closed', () => {
    const readCommands = [
      ['agoal', 'report', 'list-statistics'],
      ['aitable', 'advperm', 'role-list'],
      ['aitable', 'view', 'get', 'card'],
      ['chat', 'list-all-conversations'],
      ['chat', 'message', 'list-unread-conversations'],
    ];
    for (const args of readCommands) {
      expect(resolveDwsBusinessRisk({ args }), args.join(' ')).toBe('safe');
      expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args }), args.join(' ')).toEqual({
        risk: 'safe',
      });
    }
    expect(classifyDwsBusinessCommand(['chat', 'list-all-conversations']).policySource).toBe(
      isActiveCliVersion('1.0.55') ? 'legacy_read_table' : 'cli_schema',
    );
    expect(classifyDwsBusinessCommand(['agoal', 'report', 'list-statistics']).policySource).toBe(
      'legacy_read_table',
    );

    const shortcutAvailable = isActiveCliVersion('1.0.60');
    const currentShortcutRisk = resolveDwsBusinessRisk({
      args: ['agoal', '+report-statistics-list'],
    });
    expect(currentShortcutRisk).toBe(shortcutAvailable ? 'safe' : 'dangerous');
    expect(
      dwsBusinessToolDescriptor.resolveCallPolicy?.({
        args: ['agoal', '+report-statistics-list'],
      }),
    ).toEqual(shortcutAvailable ? { risk: 'safe' } : { risk: 'dangerous', neverAutoApprove: true });
  });

  it('按 schema 契约分档，且保留平台高影响边界和 unknown fail-closed', () => {
    expect(classifyDwsBusinessCommand(['chat', 'message', 'send'])).toMatchObject({
      risk: 'write',
      policySource: 'cli_schema',
    });
    expect(classifyDwsBusinessCommand(['attendance', 'approve', 'list'])).toMatchObject({
      risk: 'read',
      policySource: 'legacy_read_table',
    });
    expect(classifyDwsBusinessCommand(['drive', 'publish', 'get'])).toMatchObject({
      risk: 'read',
      policySource: 'legacy_read_table',
    });

    expectPolicyRejection(['doc', 'permission', 'remove'], 'platform_boundary');
    expectPolicyRejection(['doc', 'delete'], 'platform_boundary');
    expectPolicyRejection(['aisearch', 'search-behavior']);
    expectPolicyRejection(['drive', 'file', 'download'], 'platform_boundary');
    expectPolicyRejection(['calendar', 'event', 'future-query-shape'], 'unregistered');
    expectPolicyRejection(['calendar', 'event', 'future', 'list'], 'unregistered');
    expectPolicyRejection(['calendar', 'event', 'future-create'], 'unregistered');
    expectPolicyRejection(['calendar', 'event', 'future', '--help'], 'unregistered');
    expectPolicyRejection(['chat', 'message', 'send', 'all'], 'unregistered');
  });

  it('exposes reviewed v1.0.60 product modules through manifest-level policy', () => {
    for (const args of [
      ['event', 'list'],
      ['hrbrain', 'profile', 'query'],
      ['markdown', 'fetch'],
      ['recruit', 'job', 'list'],
      ['whiteboard', 'query'],
    ]) {
      expect(classifyDwsBusinessCommand(args)).toMatchObject({
        risk: 'read',
        policySource: 'cli_schema',
      });
      expect(resolveDwsBusinessRisk({ args })).toBe('safe');
    }
  });

  it('manifest 命中前拒绝破坏性 flag、文件路径与 stdin 引用', () => {
    const rejectedCommands = [
      ['attendance', 'group', 'update-members', '--group-id', '123', '--remove-users', 'u1'],
      ['sheet', 'csv-put', '--spreadsheet-id', 's1', '--csv', '@data.csv'],
      ['sheet', 'csv-put', '--spreadsheet-id', 's1', '--csv=@data.csv'],
      ['sheet', 'csv-put', '--spreadsheet-id', 's1', '--csv', 'file:///tmp/data.csv'],
      ['sheet', 'csv-put', '--spreadsheet-id', 's1', '--csv', '-'],
      ['sheet', 'range', 'batch-set-style', '--node', 'n1', '--batch', './styles.json'],
      ['sheet', 'range', 'batch-set-style', '--node', 'n1', '--batch=./styles.json'],
      ['doc', 'create', '--title', 'x', '--content', '-'],
      ['doc', 'update', '--node', 'n1', '--content', '-'],
      ['report', 'entry', 'submit', '--template-id', 't1', '--contents', '-'],
    ];
    for (const args of rejectedCommands) {
      expectPolicyRejection(args, 'platform_boundary');
      expect(resolveDwsBusinessRisk({ args, confirmed: true }), args.join(' ')).toBe('dangerous');
      expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args, confirmed: true })).toEqual({
        risk: 'dangerous',
        neverAutoApprove: true,
      });
    }
    for (const args of [
      ['sheet', 'csv-put', '--spreadsheet-id', 's1', '--csv', 'a,b\\n1,2'],
      ['doc', 'create', '--title', 'x', '--content', '正文'],
      ['doc', 'update', '--node', 'n1', '--content', '正文'],
      ['report', 'entry', 'submit', '--template-id', 't1', '--contents', '[{"key":"k"}]'],
    ]) {
      expect(resolveDwsBusinessRisk({ args, confirmed: true }), args.join(' ')).toBe(
        'workspace_write',
      );
    }
  });

  it('Dockerfile 实际版本、分版本 manifest 与缩进 skill metadata 必须同步', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const dockerVersions = [...dockerfile.matchAll(/dingtalk-workspace-cli@(\d+\.\d+\.\d+)/g)].map(
      (match) => match[1]!,
    );
    expect(dockerVersions).toEqual([DWS_ACTIVE_CLI_VERSION]);
    expect(DWS_COMMAND_POLICY_CLI_VERSIONS).toContain(DWS_ACTIVE_CLI_VERSION);

    const skill = readFileSync(
      new URL('../../../workspace-shared/.ky-agent/skills-pool/dws/SKILL.md', import.meta.url),
      'utf8',
    );
    const skillVersion = extractDwsSkillCliVersion(skill);
    expect(skillVersion).toBeDefined();
    if (!skillVersion) throw new Error('DWS skill metadata 缺少 cli_version');
    expect(skillVersionSupportsActive(skillVersion, DWS_ACTIVE_CLI_VERSION)).toBe(true);

    expect(extractDwsSkillCliVersion('metadata:\n  cli_version: "1.0.60"\n')).toBe('1.0.60');
    expect(skillVersionSupportsActive('1.0.60', '1.0.55')).toBe(false);
  });
});

function countGeneratedFileFlags(version: '1.0.55' | '1.0.60'): number {
  return Object.values(DWS_COMMAND_FILE_FLAGS_BY_CLI_VERSION[version]).reduce(
    (sum, flags) => sum + Object.keys(flags).length,
    0,
  );
}

function isActiveCliVersion(version: string): boolean {
  return DWS_ACTIVE_CLI_VERSION === version;
}

function extractDwsSkillCliVersion(source: string): string | undefined {
  return source.match(/^\s*cli_version:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1]?.trim();
}

function skillVersionSupportsActive(requirement: string, activeVersion: string): boolean {
  if (/^\d+\.\d+\.\d+$/.test(requirement)) return requirement === activeVersion;
  const minimum = requirement.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
  if (!minimum) throw new Error(`不支持的 DWS skill cli_version：${requirement}`);
  return compareSemver(activeVersion, minimum) >= 0;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function expectPolicyRejection(
  args: string[],
  source?: DwsCommandPolicyError['policySource'],
): void {
  try {
    classifyDwsBusinessCommand(args);
    throw new Error(`预期命令被拒绝：${args.join(' ')}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DwsCommandPolicyError);
    if (source) expect(error).toMatchObject({ policySource: source });
  }
}

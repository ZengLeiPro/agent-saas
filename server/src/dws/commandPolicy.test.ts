import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dwsBusinessToolDescriptor, resolveDwsBusinessRisk } from './businessToolProvider.js';
import {
  classifyDwsBusinessCommand,
  DWS_COMMAND_POLICY_CLI_VERSIONS,
  DwsCommandPolicyError,
} from './commandPolicy.js';
import {
  DWS_COMMAND_POLICY_BY_PATH,
  DWS_COMMAND_POLICY_CATALOGS,
} from './generated/commandPolicy.js';

describe('DWS CLI schema 命令策略', () => {
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
    expect(Object.keys(DWS_COMMAND_POLICY_BY_PATH)).toHaveLength(1236);
    expect(DWS_COMMAND_POLICY_BY_PATH['mcp.url.get']).toBe('d');
    expect(DWS_COMMAND_POLICY_BY_PATH['devapp.credentials-get']).toBe('d');
  });

  it('TASK-335 复现的五条查询和 1.0.60 快捷命令均不再触发授权', () => {
    const readCommands = [
      ['agoal', 'report', 'list-statistics'],
      ['aitable', 'advperm', 'role-list'],
      ['aitable', 'view', 'get', 'card'],
      ['chat', 'list-all-conversations'],
      ['chat', 'message', 'list-unread-conversations'],
      ['agoal', '+report-statistics-list'],
    ];
    for (const args of readCommands) {
      expect(resolveDwsBusinessRisk({ args }), args.join(' ')).toBe('safe');
      expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args }), args.join(' ')).toEqual({
        risk: 'safe',
      });
    }
    expect(classifyDwsBusinessCommand(['chat', 'list-all-conversations']).policySource).toBe(
      'cli_schema',
    );
    expect(classifyDwsBusinessCommand(['agoal', 'report', 'list-statistics']).policySource).toBe(
      'legacy_read_table',
    );
  });

  it('按 schema 契约分档，同时保留平台高影响边界和 unknown fail-closed', () => {
    expect(classifyDwsBusinessCommand(['chat', 'message', 'send'])).toMatchObject({
      risk: 'write',
      policySource: 'cli_schema',
    });
    expect(classifyDwsBusinessCommand(['attendance', 'approve', 'list'])).toMatchObject({
      risk: 'read',
      policySource: 'cli_schema',
    });
    expect(classifyDwsBusinessCommand(['drive', 'publish', 'get'])).toMatchObject({
      risk: 'read',
      policySource: 'legacy_read_table',
    });

    expectPolicyRejection(['doc', 'permission', 'remove'], 'platform_boundary');
    expectPolicyRejection(['doc', 'delete'], 'cli_schema');
    expectPolicyRejection(['aisearch', 'search-behavior'], 'cli_schema');
    expectPolicyRejection(['drive', 'file', 'download'], 'platform_boundary');
    expectPolicyRejection(['calendar', 'event', 'future-query-shape'], 'unregistered');
  });

  it('Dockerfile 与精确 skill CLI 版本升级时要求同步 manifest', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const dockerVersions = [...dockerfile.matchAll(/dingtalk-workspace-cli@(\d+\.\d+\.\d+)/g)].map(
      (match) => match[1]!,
    );
    expect(dockerVersions.length).toBeGreaterThan(0);
    for (const version of dockerVersions) {
      expect(
        DWS_COMMAND_POLICY_CLI_VERSIONS,
        `Dockerfile CLI ${version} 缺少命令策略 catalog`,
      ).toContain(version);
    }

    const skill = readFileSync(
      new URL('../../../workspace-shared/.ky-agent/skills-pool/dws/SKILL.md', import.meta.url),
      'utf8',
    );
    const skillVersion = skill.match(/^cli_version:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
    if (skillVersion && /^\d+\.\d+\.\d+$/.test(skillVersion)) {
      expect(
        DWS_COMMAND_POLICY_CLI_VERSIONS,
        `DWS skill CLI ${skillVersion} 缺少命令策略 catalog`,
      ).toContain(skillVersion);
    }
  });
});

function expectPolicyRejection(
  args: string[],
  source: DwsCommandPolicyError['policySource'],
): void {
  try {
    classifyDwsBusinessCommand(args);
    throw new Error(`预期命令被拒绝：${args.join(' ')}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DwsCommandPolicyError);
    expect(error).toMatchObject({ policySource: source });
  }
}

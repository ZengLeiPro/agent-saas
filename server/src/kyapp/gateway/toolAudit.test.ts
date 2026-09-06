/**
 * WP3 Phase B：`tool_audit` 扩字段（规范 §6.2-8）。
 *
 * 重点钉死两件事：
 * 1. **非 `app__` 工具的 tool_audit 行逐字节不变**（旧 jsonl / DuckDB 旧库不受影响）；
 * 2. 审计只存哈希与字节数，**不存明文入参与结果**。
 */
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@kaiyan/ky-app-contract';

import {
  APP_CAPABILITY_AUDIT_KEYS,
  buildToolAuditExtension,
} from '../../runtime/toolAuditEvent.js';
import { buildAppResultMetadata } from './envelope.js';
import type { AppCapabilityEntry } from './snapshot.js';

const CONTEXT = {
  channelContext: {
    channel: 'web' as const,
    user: { id: 'u-1', username: 'alice', role: 'user' as const, tenantId: 'org-1' },
  },
} as never;

function entry(): AppCapabilityEntry {
  return {
    installationId: 'iid-1',
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId: 'order.create',
    toolName: 'app__demo_erp__order_create',
    capabilityName: '建订单',
    description: '建订单',
    riskLevel: 'external_write',
    safeToRetry: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    registeredDigest: 'a'.repeat(64),
    baseUrl: 'https://erp.example.com',
  };
}

describe('tool_audit 扩字段', () => {
  it('非定制项目工具：只保留 approvalId，其它键一个都不加', () => {
    expect(
      buildToolAuditExtension({ approved: true, source: 'policy_auto' }, CONTEXT, undefined),
    ).toEqual({});
    expect(
      buildToolAuditExtension(
        { approved: true, approvalId: 'ap-1', source: 'human_approval' },
        CONTEXT,
        // Shell 之类工具的 metadata 里没有 installationId
        { exitCode: 0, stdoutBytes: 12 },
      ),
    ).toEqual({ approvalId: 'ap-1' });
  });

  it('定制项目能力：11 个扩展字段全部落到 tool_audit', () => {
    const inputHash = sha256Hex('x');
    const metadata = buildAppResultMetadata({
      entry: entry(),
      lcid: 'lc-1',
      requestId: 'rid-1',
      attempts: 2,
      approvalId: 'ap-1',
      inputHash,
      outcome: {
        kind: 'success',
        data: { orderId: 'A1' },
        outputBytes: 42,
        outputHash: sha256Hex('y'),
      },
    });
    const extension = buildToolAuditExtension(
      { approved: true, approvalId: 'ap-1', source: 'human_approval' },
      CONTEXT,
      metadata,
    );
    expect(extension).toEqual({
      approvalId: 'ap-1',
      userId: 'u-1',
      installationId: 'iid-1',
      capabilityId: 'order.create',
      lcid: 'lc-1',
      requestId: 'rid-1',
      dig: 'a'.repeat(64),
      inputHash,
      outputHash: sha256Hex('y'),
      outputBytes: 42,
      origin: 'agent_tool',
    });
    // 规范 §6.2-8 点名的字段一个不漏（approvalId 本来就有）。
    for (const key of APP_CAPABILITY_AUDIT_KEYS) {
      if (key === 'errorCode') continue;
      expect(extension).toHaveProperty(key);
    }
  });

  it('失败调用带 errorCode，且不带 data', () => {
    const metadata = buildAppResultMetadata({
      entry: entry(),
      lcid: 'lc-2',
      requestId: 'rid-2',
      attempts: 5,
      outcome: { kind: 'failure', code: 'outcome_unknown', logMessage: '内部 SQL 报错' },
    });
    const extension = buildToolAuditExtension(
      { approved: true, source: 'policy_auto' },
      CONTEXT,
      metadata,
    );
    expect(extension.errorCode).toBe('outcome_unknown');
    expect(JSON.stringify(extension)).not.toContain('SQL');
  });

  it('审计只存哈希：明文入参与结果不出现在任何字段里', () => {
    const secret = '客户手机号 13900000000';
    const metadata = buildAppResultMetadata({
      entry: entry(),
      lcid: 'lc-3',
      requestId: 'rid-3',
      attempts: 1,
      inputHash: sha256Hex(secret),
      outcome: {
        kind: 'success',
        data: { phone: secret },
        outputBytes: 30,
        outputHash: sha256Hex(secret),
      },
    });
    const extension = buildToolAuditExtension(
      { approved: true, source: 'policy_auto' },
      CONTEXT,
      metadata,
    );
    expect(JSON.stringify(extension)).not.toContain('13900000000');
    expect(extension.inputHash).toBe(sha256Hex(secret));
  });

  it('origin 缺省 agent_tool，可由调用方改写（§5.4 壳内 iframe 发起）', () => {
    const metadata = buildAppResultMetadata({
      entry: entry(),
      lcid: 'lc-4',
      requestId: 'rid-4',
      attempts: 1,
      origin: 'app_iframe',
      outcome: { kind: 'success', data: null, outputBytes: 4 },
    });
    expect(
      buildToolAuditExtension({ approved: true, source: 'policy_auto' }, CONTEXT, metadata).origin,
    ).toBe('app_iframe');
  });
});

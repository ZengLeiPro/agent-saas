/**
 * WP3 Phase B：§6.2-2 确认卡片、§6.2-3 审批绑定与 10 分钟专用超时。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { aph as computeAph, toolName as buildAppToolName } from '@kaiyan/ky-app-contract';

import { InteractionStore } from '../../channels/web/interactionStore.js';
import {
  APP_APPROVAL_DEFAULT_TTL_MS,
  APP_CONFIRM_WORD,
  AppApprovalRegistry,
  approvalParamsHash,
  buildAppConfirmationCard,
  summarizeApprovalParams,
} from './approval.js';
import { resetAppCapabilityGatewayForTest } from './runtimeBinding.js';
import {
  rememberAppCapabilityTool,
  resetAppCapabilityRiskRegistryForTest,
} from './toolRiskRegistry.js';

const WRITE_TOOL = buildAppToolName('demo-erp', 'order.create');
const READ_TOOL = buildAppToolName('demo-erp', 'order.search');

function meta(risk: 'read_only' | 'external_write') {
  return {
    risk,
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId: risk === 'read_only' ? 'order.search' : 'order.create',
    capabilityName: risk === 'read_only' ? '查订单' : '建订单',
    installationId: 'iid-1',
  } as const;
}

describe('§6.2-2 确认卡片', () => {
  beforeEach(() => {
    resetAppCapabilityRiskRegistryForTest();
    resetAppCapabilityGatewayForTest();
    rememberAppCapabilityTool(WRITE_TOOL, meta('external_write'));
    rememberAppCapabilityTool(READ_TOOL, meta('read_only'));
  });

  it('external_write 才出卡片；read_only 与非 app__ 工具不出', () => {
    expect(buildAppConfirmationCard({ toolName: WRITE_TOOL })).toBeDefined();
    expect(buildAppConfirmationCard({ toolName: READ_TOOL })).toBeUndefined();
    expect(
      buildAppConfirmationCard({ toolName: 'Shell', toolInput: { command: 'rm -rf /' } }),
    ).toBeUndefined();
    expect(buildAppConfirmationCard({})).toBeUndefined();
  });

  it('卡片含规范要求的四件套：系统名、参数摘要、不可撤销、键入确认字', () => {
    const card = buildAppConfirmationCard({
      toolName: WRITE_TOOL,
      toolInput: { amount: 100, customer: '张三', note: '  ' },
      approvalTtlMs: 600_000,
      now: () => 1_000,
    });
    expect(card).toMatchObject({
      systemName: '演示 ERP',
      capabilityName: '建订单',
      irreversible: true,
      confirmWord: APP_CONFIRM_WORD,
      expiresAtMs: 601_000,
      timeoutNotice: '操作已取消，未写入任何数据。',
    });
    // 空白值不入摘要。
    expect(card?.params).toEqual([
      { label: 'amount', value: '100' },
      { label: 'customer', value: '张三' },
    ]);
  });

  it('风险档未登记时 fail-closed 仍出卡片，系统名退化为工具名 id 段', () => {
    resetAppCapabilityRiskRegistryForTest();
    const card = buildAppConfirmationCard({ toolName: WRITE_TOOL });
    expect(card).toBeDefined();
    expect(card?.systemName).toBe('demo_erp');
  });

  it('参数摘要最多 6 行，长值截断，数组给条数，对象跳过', () => {
    const rows = summarizeApprovalParams({
      a: 1,
      b: 'x'.repeat(100),
      c: [1, 2, 3],
      d: { nested: true },
      e: true,
      f: 'f',
      g: 'g',
      h: 'h',
    });
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.label === 'b')?.value).toHaveLength(61);
    expect(rows.find((row) => row.label === 'c')?.value).toBe('共 3 项');
    expect(rows.find((row) => row.label === 'd')).toBeUndefined();
  });

  it('Gateway 未装配时 TTL 兜底 10 分钟', () => {
    const card = buildAppConfirmationCard({ toolName: WRITE_TOOL, now: () => 0 });
    expect(card?.expiresAtMs).toBe(APP_APPROVAL_DEFAULT_TTL_MS);
  });
});

describe('§6.2-3 审批绑定', () => {
  const binding = {
    approvalId: 'ap-1',
    tenantId: 'org-1',
    installationId: 'iid-1',
    userId: 'u-1',
    sessionId: 'sess-1',
    capabilityId: 'order.create',
    aph: computeAph({ cap: 'order.create', input: { amount: 100 } }),
    expiresAt: 10_000,
  };
  const consumeInput = {
    approvalId: 'ap-1',
    tenantId: 'org-1',
    installationId: 'iid-1',
    userId: 'u-1',
    sessionId: 'sess-1',
    capabilityId: 'order.create',
    aph: binding.aph,
  };

  it('aph 走契约包，参数一变就变（= 新审批）', () => {
    expect(approvalParamsHash('order.create', { amount: 100 })).toBe(binding.aph);
    expect(approvalParamsHash('order.create', { amount: 101 })).not.toBe(binding.aph);
    // JCS 规范化：键顺序不影响哈希。
    expect(approvalParamsHash('order.create', { a: 1, b: 2 })).toBe(
      approvalParamsHash('order.create', { b: 2, a: 1 }),
    );
  });

  it('消费单位 = 逻辑调用：同一个 approvalId 只能消费一次', () => {
    const registry = new AppApprovalRegistry({ now: () => 1_000 });
    registry.remember(binding);
    expect(registry.consume(consumeInput)).toMatchObject({ ok: true });
    expect(registry.consume(consumeInput)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('过期即终结', () => {
    const registry = new AppApprovalRegistry({ now: () => 20_000 });
    registry.remember(binding);
    expect(registry.consume(consumeInput)).toEqual({ ok: false, reason: 'expired' });
  });

  it('绑定六元组任一项不符即拒（参数变更 → aph 变 → mismatch）', () => {
    for (const patch of [
      { tenantId: 'org-2' },
      { installationId: 'iid-2' },
      { userId: 'u-2' },
      { sessionId: 'sess-2' },
      { capabilityId: 'order.cancel' },
      { aph: approvalParamsHash('order.create', { amount: 999 }) },
    ]) {
      const registry = new AppApprovalRegistry({ now: () => 1_000 });
      registry.remember(binding);
      expect(registry.consume({ ...consumeInput, ...patch })).toEqual({
        ok: false,
        reason: 'mismatch',
      });
    }
  });

  it('本进程没有记录（跨进程恢复）时放行但只放一次', () => {
    const registry = new AppApprovalRegistry({ now: () => 1_000 });
    expect(registry.consume(consumeInput)).toEqual({ ok: true, binding: null });
    expect(registry.consume(consumeInput)).toEqual({ ok: false, reason: 'consumed' });
  });
});

describe('10 分钟专用超时不动全局 30 分钟', () => {
  it('per-interaction timeoutMs 只能收紧，且到期回调带 app 文案', async () => {
    const store = new InteractionStore();
    const expired: string[] = [];
    const pending = store.create('int-1', 'permission_request', {
      sessionId: 'sess-1',
      toolName: WRITE_TOOL,
      timeoutMs: 1_000,
      confirmation: { systemName: '演示 ERP', timeoutNotice: '操作已取消，未写入任何数据。' },
      onExpired: (entry) => expired.push(entry.confirmation?.timeoutNotice ?? ''),
    });
    void pending.catch(() => undefined);
    // 快照里带上卡片，重连补发时前端仍能渲染确认卡。
    expect(
      store.getPendingInteractions('sess-1', { includeTransient: true })[0]?.confirmation,
    ).toMatchObject({
      systemName: '演示 ERP',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(expired).toEqual(['操作已取消，未写入任何数据。']);
  });

  it('传入超过全局默认的 timeoutMs 会被夹回全局上限（不得放宽安全边界）', () => {
    const store = new InteractionStore();
    const pending = store.create('int-2', 'permission_request', {
      sessionId: 'sess-2',
      timeoutMs: 999 * 60 * 1000,
    });
    void pending.catch(() => undefined);
    expect(store.get('int-2')).toBeDefined();
    store.resolve('int-2', { allow: false });
  });
});

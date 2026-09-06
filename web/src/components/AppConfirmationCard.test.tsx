/**
 * WP3 §6.2-2：外部系统写操作确认卡片的前端行为。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionBlock } from './PermissionBlock';
import { MessageItem } from './MessageItem';
import { deriveConfirmationCard } from './appConfirmation';

const WRITE_TOOL = 'app__demo_erp__order_create';

function renderBlock(overrides: Partial<Parameters<typeof PermissionBlock>[0]> = {}) {
  const onAllow = vi.fn();
  const onDeny = vi.fn();
  render(
    <PermissionBlock
      toolName={WRITE_TOOL}
      toolInput={JSON.stringify({ amount: 100, customer: '张三' })}
      status="pending"
      onAllow={onAllow}
      onDeny={onDeny}
      {...overrides}
    />,
  );
  return { onAllow, onDeny };
}

describe('AppConfirmationCard', () => {
  it('从消息投影带下来的卡片字段渲染客户面系统名', async () => {
    render(
      <MessageItem
        index={0}
        message={{
          id: 'app-permission',
          type: 'permission_request',
          interactionId: 'write-1',
          toolName: WRITE_TOOL,
          toolInput: JSON.stringify({ amount: 100 }),
          status: 'pending',
          confirmation: {
            systemName: '客户订单系统',
            capabilityName: '创建销售订单',
          },
        }}
      />,
    );
    expect(await screen.findByText(/客户订单系统/)).toBeTruthy();
    expect(screen.getByText(/创建销售订单/)).toBeTruthy();
  });

  it('渲染系统名、参数摘要与「确认后立即生效、不可撤销」', async () => {
    renderBlock({
      confirmation: {
        systemName: '演示 ERP',
        capabilityName: '建订单',
        params: [
          { label: '金额', value: '100' },
          { label: '客户', value: '张三' },
        ],
        irreversible: true,
        confirmWord: '确认',
      },
    });
    expect(await screen.findByText(/演示 ERP/)).toBeTruthy();
    expect(screen.getByText(/建订单/)).toBeTruthy();
    expect(screen.getByText('金额')).toBeTruthy();
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.getByText('确认后立即生效、不可撤销。')).toBeTruthy();
  });

  it('未键入确认字时「确认执行」不可点；键入后才可点', async () => {
    const { onAllow } = renderBlock({
      confirmation: { systemName: '演示 ERP', capabilityName: '建订单', confirmWord: '确认' },
    });
    const confirm = (await screen.findByLabelText('确认执行')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onAllow).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('键入 确认 以继续'), { target: { value: '确认' } });
    expect((screen.getByLabelText('确认执行') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('确认执行'));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('键错确认字不放行', async () => {
    const { onAllow } = renderBlock({
      confirmation: { systemName: '演示 ERP', confirmWord: '确认' },
    });
    fireEvent.change(await screen.findByLabelText('键入 确认 以继续'), {
      target: { value: '确认执行' },
    });
    expect((screen.getByLabelText('确认执行') as HTMLButtonElement).disabled).toBe(true);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it('「取消」无需键入确认字', async () => {
    const { onDeny } = renderBlock({ confirmation: { systemName: '演示 ERP' } });
    fireEvent.click(await screen.findByLabelText('取消'));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('过期后展示「操作已取消，未写入任何数据」，且不再提供确认入口', async () => {
    renderBlock({
      confirmation: {
        systemName: '演示 ERP',
        confirmWord: '确认',
        expiresAtMs: Date.now() - 1_000,
        timeoutNotice: '操作已取消，未写入任何数据。',
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      '操作已取消，未写入任何数据。',
    );
    expect(screen.queryByLabelText('确认执行')).toBeNull();
  });

  it('服务端没给卡片时按工具名与入参兜底推导，绝不退回两键卡片', async () => {
    renderBlock();
    expect(await screen.findByTestId('app-confirmation-card')).toBeTruthy();
    expect(screen.getByText('确认后立即生效、不可撤销。')).toBeTruthy();
    // 旧的 Allow / Deny 两键不再出现在 app__ 写操作上。
    expect(screen.queryByLabelText('Allow')).toBeNull();
    expect(screen.getByText('amount')).toBeTruthy();
  });

  it('非 app__ 工具保持原有两键卡片不变', () => {
    render(
      <PermissionBlock
        toolName="Shell"
        toolInput={JSON.stringify({ command: 'echo hi' })}
        status="pending"
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('app-confirmation-card')).toBeNull();
    expect(screen.getByLabelText('Allow')).toBeTruthy();
  });

  it('兜底推导：长值截断、数组给条数、对象跳过、最多 6 行', () => {
    const card = deriveConfirmationCard(
      WRITE_TOOL,
      JSON.stringify({ a: 'x'.repeat(100), b: [1, 2], c: { n: 1 }, d: 1, e: 2, f: 3, g: 4, h: 5 }),
    );
    expect(card.systemName).toBe('demo_erp');
    expect(card.capabilityName).toBe('order_create');
    expect(card.params).toHaveLength(6);
    expect(card.params?.[0]?.value).toHaveLength(61);
    expect(card.params?.find((row) => row.label === 'b')?.value).toBe('共 2 项');
    expect(card.params?.find((row) => row.label === 'c')).toBeUndefined();
  });

  it('入参不是合法 JSON 时仍出卡片，只是没有参数摘要', async () => {
    renderBlock({ toolInput: '{not json' });
    expect(await screen.findByTestId('app-confirmation-card')).toBeTruthy();
    expect(screen.getByText('本次操作没有需要确认的参数。')).toBeTruthy();
  });
});

/**
 * 运行状态 → 颜色族映射测试。
 * 状态四件套是全站唯一语义，颜色一旦漂移（例如 error 落到 warning）
 * 会直接误导用户，所以这里逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from '../../theme/colors';
import { resolveStatusTone, statusLabel, type RunStatus } from './statusStyles';

describe('resolveStatusTone', () => {
  it('running → info 族且图标旋转', () => {
    const tone = resolveStatusTone('running', lightColors);
    expect(tone.tint).toBe(lightColors.infoFamily.DEFAULT);
    expect(tone.ink).toBe(lightColors.infoFamily.ink);
    expect(tone.badgeVariant).toBe('info');
    expect(tone.spinning).toBe(true);
  });

  it('success → success 族，error → danger 族，均不旋转', () => {
    const success = resolveStatusTone('success', lightColors);
    expect(success.tint).toBe(lightColors.successFamily.DEFAULT);
    expect(success.badgeVariant).toBe('success');
    expect(success.spinning).toBe(false);

    const error = resolveStatusTone('error', lightColors);
    expect(error.tint).toBe(lightColors.dangerFamily.DEFAULT);
    expect(error.badgeVariant).toBe('danger');
    expect(error.spinning).toBe(false);
  });

  it('cancelled / pending → 中性灰，不占用任何语义色', () => {
    for (const status of ['cancelled', 'pending'] as const) {
      const tone = resolveStatusTone(status, lightColors);
      expect(tone.tint).toBe(lightColors.mutedForeground);
      expect(tone.subtle).toBe(lightColors.muted);
      expect(tone.badgeVariant).toBe('secondary');
      expect(tone.spinning).toBe(false);
    }
  });

  it('只有 running 会旋转', () => {
    const all: RunStatus[] = ['running', 'success', 'error', 'cancelled', 'pending'];
    expect(all.filter((s) => resolveStatusTone(s, darkColors).spinning)).toEqual(['running']);
  });

  it('每个状态都有中文文案，且暗色下同样解析成功', () => {
    const all: RunStatus[] = ['running', 'success', 'error', 'cancelled', 'pending'];
    for (const status of all) {
      expect(statusLabel(status)).toBeTruthy();
      expect(resolveStatusTone(status, darkColors).label).toBe(statusLabel(status));
    }
  });
});

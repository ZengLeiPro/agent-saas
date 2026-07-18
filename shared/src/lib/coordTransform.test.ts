/**
 * coordTransform.ts 测试
 *
 * 关注：
 * - 中国境内坐标会被偏移（WGS-84 → GCJ-02），偏移量在合理范围内
 * - 中国境外坐标原样返回（isInChina 兜底分支）
 * - 边界矩形的四条边界（含刚好命中与刚好越界）
 */
import { describe, expect, it } from 'vitest';
import { wgs84ToGcj02 } from './coordTransform';

describe('wgs84ToGcj02', () => {
  it('中国境内坐标会被偏移，且偏移量在数百米量级（约 0.001~0.01 度）', () => {
    // 天安门 WGS-84 ≈ (116.391, 39.907)
    const { lng, lat } = wgs84ToGcj02(116.391, 39.907);
    // 结果与输入不同（发生了偏移）
    expect(lng).not.toBe(116.391);
    expect(lat).not.toBe(39.907);
    // GCJ-02 相对 WGS-84 的经纬偏移在国内通常 0.001~0.01 度之间
    const dLng = Math.abs(lng - 116.391);
    const dLat = Math.abs(lat - 39.907);
    expect(dLng).toBeGreaterThan(0.001);
    expect(dLng).toBeLessThan(0.02);
    expect(dLat).toBeGreaterThan(0.001);
    expect(dLat).toBeLessThan(0.02);
  });

  it('境外坐标（东京）原样返回，不做偏移', () => {
    const result = wgs84ToGcj02(139.767, 35.681);
    expect(result).toEqual({ lng: 139.767, lat: 35.681 });
  });

  it('刚好落在矩形外（经度 < 73.66）原样返回', () => {
    const result = wgs84ToGcj02(73.0, 30.0);
    expect(result).toEqual({ lng: 73.0, lat: 30.0 });
  });

  it('刚好落在矩形外（纬度 > 53.55）原样返回', () => {
    const result = wgs84ToGcj02(100.0, 60.0);
    expect(result).toEqual({ lng: 100.0, lat: 60.0 });
  });

  it('刚好命中矩形内（边界纬度 3.86）会被偏移', () => {
    const result = wgs84ToGcj02(100.0, 3.86);
    expect(result).not.toEqual({ lng: 100.0, lat: 3.86 });
  });

  it('对同一输入是确定性的（纯函数无副作用）', () => {
    const a = wgs84ToGcj02(121.4737, 31.2304); // 上海
    const b = wgs84ToGcj02(121.4737, 31.2304);
    expect(a).toEqual(b);
  });
});

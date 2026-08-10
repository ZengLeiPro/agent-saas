import { describe, expect, it } from 'vitest';

import { ipv4InCidr, parseIpv4Cidr } from './cidr.js';

describe('parseIpv4Cidr', () => {
  it('归一化到网络地址', () => {
    expect(parseIpv4Cidr('172.16.179.212/24')?.canonical).toBe('172.16.179.0/24');
    expect(parseIpv4Cidr('172.16.179.0/24')?.canonical).toBe('172.16.179.0/24');
  });

  it('支持 /0 与 /32 边界（/0 的 32 位移位在 JS 里是陷阱）', () => {
    expect(parseIpv4Cidr('0.0.0.0/0')?.canonical).toBe('0.0.0.0/0');
    expect(parseIpv4Cidr('172.16.179.5/32')?.canonical).toBe('172.16.179.5/32');
  });

  it('拒绝非法输入', () => {
    for (const bad of ['', 'abc', '172.16.179.0', '172.16.179.0/33', '999.1.1.1/24', '172.16.179.0/x', '1.2.3/24']) {
      expect(parseIpv4Cidr(bad), bad).toBeNull();
    }
    expect(parseIpv4Cidr(undefined)).toBeNull();
  });
});

describe('ipv4InCidr（SNAT shared-cidr 的安全兜底判据）', () => {
  const shared = '172.16.179.0/24';

  it('生产实测 pod IP 全部落在托管网段内', () => {
    for (const ip of ['172.16.179.174', '172.16.179.204', '172.16.179.206', '172.16.179.212']) {
      expect(ipv4InCidr(ip, shared), ip).toBe(true);
    }
  });

  it('ECS 网段不在内——这正是共享网段不会波及 ECS 的保证', () => {
    for (const ip of ['172.16.177.80', '172.16.177.76', '172.16.177.77']) {
      expect(ipv4InCidr(ip, shared), ip).toBe(false);
    }
  });

  it('相邻 /24 越界被识别（触发回退 per-pod 的关键场景）', () => {
    expect(ipv4InCidr('172.16.180.5', shared)).toBe(false);
    expect(ipv4InCidr('172.16.178.255', shared)).toBe(false);
  });

  it('边界地址包含在内', () => {
    expect(ipv4InCidr('172.16.179.0', shared)).toBe(true);
    expect(ipv4InCidr('172.16.179.255', shared)).toBe(true);
  });

  it('输入不可解析时 fail-closed 返回 false（宁可回退 per-pod 也不放行）', () => {
    expect(ipv4InCidr(undefined, shared)).toBe(false);
    expect(ipv4InCidr('', shared)).toBe(false);
    expect(ipv4InCidr('not-an-ip', shared)).toBe(false);
    expect(ipv4InCidr('172.16.179.5', undefined)).toBe(false);
    expect(ipv4InCidr('172.16.179.5', 'garbage')).toBe(false);
  });
});

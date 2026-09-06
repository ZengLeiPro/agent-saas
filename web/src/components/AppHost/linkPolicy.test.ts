/**
 * §5.4 `link.open` 的壳侧准入。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  checkExternalLink,
  externalLinkConfirmText,
  isIpLiteral,
  openExternalLink,
} from './linkPolicy';

const HOSTS = ['docs.example.com', 'Help.Example.COM'];

describe('checkExternalLink', () => {
  it('白名单内的 https 链接放行，并给出规范化 URL', () => {
    const verdict = checkExternalLink('https://docs.example.com/a?b=1#c', HOSTS);
    expect(verdict.ok).toBe(true);
    expect(verdict.url).toBe('https://docs.example.com/a?b=1#c');
    expect(verdict.displayHost).toBe('docs.example.com');
  });

  it('白名单大小写不敏感', () => {
    expect(checkExternalLink('https://help.example.com/', HOSTS).ok).toBe(true);
  });

  it.each([
    ['http://docs.example.com/', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['data:text/html,<script>', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
    ['https://user:pass@docs.example.com/', 'userinfo'],
    ['https://user@docs.example.com/', 'userinfo'],
    ['https://127.0.0.1/', 'ip_host'],
    ['https://3232235777/', 'ip_host'],
    ['https://0x7f000001/', 'ip_host'],
    ['https://[::1]/', 'ip_host'],
    ['https://evil.example.com/', 'not_allowlisted'],
    ['https://docs.example.com.evil.com/', 'not_allowlisted'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
  ])('拒绝 %s，原因 %s', (url, reason) => {
    expect(checkExternalLink(url, HOSTS)).toEqual({ ok: false, reason });
  });

  it('非字符串一律 invalid_url（子端可以发任何东西过来）', () => {
    for (const value of [undefined, null, 7, {}, []]) {
      expect(checkExternalLink(value, HOSTS).reason).toBe('invalid_url');
    }
  });

  it('白名单为空时 fail-closed', () => {
    expect(checkExternalLink('https://docs.example.com/', [])).toEqual({
      ok: false,
      reason: 'not_allowlisted',
    });
  });

  it('国际化域名以 punycode 展示（同形字攻击看得见）', () => {
    const punycode = 'xn--pple-43d.com';
    const verdict = checkExternalLink('https://аpple.com/', [punycode]);
    expect(verdict.ok).toBe(true);
    expect(verdict.displayHost).toBe(punycode);
    expect(externalLinkConfirmText(verdict.displayHost!)).toContain('外部网站');
    expect(externalLinkConfirmText(verdict.displayHost!)).toContain(punycode);
  });
});

describe('isIpLiteral', () => {
  it('域名不是 IP', () => {
    for (const host of ['example.com', 'a1.example.com', '1a.example.com']) {
      expect(isIpLiteral(host)).toBe(false);
    }
  });
});

describe('openExternalLink', () => {
  it('必须带 noopener,noreferrer', () => {
    const open = vi.fn(() => ({}) as Window);
    expect(
      openExternalLink('https://docs.example.com/', open as unknown as typeof window.open),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith('https://docs.example.com/', '_blank', 'noopener,noreferrer');
  });

  it('返回 null 不算失败：带 noopener 时规范就规定返回 null，据此判失败会让放行的外链全被报成 ok:false', () => {
    const open = vi.fn(() => null);
    expect(
      openExternalLink('https://docs.example.com/', open as unknown as typeof window.open),
    ).toBe(true);
  });

  it('open 抛异常才回 false（沙箱禁止打开新窗口等）', () => {
    const open = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(
      openExternalLink('https://docs.example.com/', open as unknown as typeof window.open),
    ).toBe(false);
  });
});

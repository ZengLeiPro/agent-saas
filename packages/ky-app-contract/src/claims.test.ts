import { describe, expect, it } from 'vitest';

import { SAT_CLAIM_MATRIX, checkSatClaims } from './claims.js';
import { EXAMPLE_SAT_AGENT_CLAIMS, EXAMPLE_SAT_USER_CLAIMS } from './vectors.js';
import { SAT_ACTS } from './types/claims.js';

function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...EXAMPLE_SAT_USER_CLAIMS, ...overrides };
}

function agentClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...EXAMPLE_SAT_AGENT_CLAIMS, ...overrides };
}

function platformClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://agent.kaiyan.net',
    aud: 'demo-erp',
    tid: 't_demo',
    iid: 'tsi_01',
    act: 'platform',
    rid: 'req_x',
    iat: 1788540000,
    nbf: 1788540000,
    exp: 1788540060,
    jti: 'MDAwMTExMjIyMzMzNDQ0NTU3',
    ...overrides,
  };
}

const SAMPLES: Readonly<Record<string, () => Record<string, unknown>>> = {
  user: userClaims,
  agent: agentClaims,
  platform: platformClaims,
};

describe('附录 B 的两个示例', () => {
  it('user 示例通过', () => {
    const result = checkSatClaims(userClaims());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.act).toBe('user');
  });

  it('agent 示例（已确认写）通过', () => {
    const result = checkSatClaims(agentClaims());
    expect(result.errors).toEqual([]);
    expect(result.act).toBe('agent');
  });

  it('platform 示例通过', () => {
    expect(checkSatClaims(platformClaims()).errors).toEqual([]);
  });
});

describe('claims 矩阵逐行', () => {
  for (const act of SAT_ACTS) {
    const row = SAT_CLAIM_MATRIX[act];

    it(`act=${act}：每一个「禁」的 claim 出现即拒`, () => {
      const forbidden = Object.entries(row)
        .filter(([, requirement]) => requirement === 'forbidden')
        .map(([claim]) => claim);
      expect(forbidden.length).toBeGreaterThan(0);
      for (const claim of forbidden) {
        const value = claim === 'tadm' ? true : claim === 'pfx' ? ['/api/app/'] : 'x';
        const result = checkSatClaims({ ...SAMPLES[act]!(), [claim]: value });
        expect(result.ok, `${act} 应拒绝 ${claim}`).toBe(false);
        expect(result.errors.join('\n')).toContain(`禁止携带 claim ${claim}`);
      }
    });

    it(`act=${act}：每一个「必」的 claim 缺失即拒`, () => {
      const required = Object.entries(row)
        .filter(([, requirement]) => requirement === 'required')
        .map(([claim]) => claim);
      for (const claim of required) {
        const claims = SAMPLES[act]!();
        delete claims[claim];
        const result = checkSatClaims(claims);
        expect(result.ok, `${act} 应拒绝缺少 ${claim}`).toBe(false);
        expect(result.errors.join('\n')).toContain(`缺少必填 claim ${claim}`);
      }
    });
  }
});

describe('apr / aph 成对与未知 act', () => {
  it('apr 无 aph 被拒', () => {
    const claims = agentClaims();
    delete claims.aph;
    expect(checkSatClaims(claims).errors.join('\n')).toMatch(/apr 与 aph 必须成对出现/u);
  });

  it('aph 无 apr 被拒', () => {
    const claims = agentClaims();
    delete claims.apr;
    expect(checkSatClaims(claims).errors.join('\n')).toMatch(/apr 与 aph 必须成对出现/u);
  });

  it('两者都不带通过', () => {
    const claims = agentClaims();
    delete claims.apr;
    delete claims.aph;
    expect(checkSatClaims(claims).errors).toEqual([]);
  });

  it('act=foo 被拒', () => {
    const result = checkSatClaims(userClaims({ act: 'foo' }));
    expect(result.ok).toBe(false);
    expect(result.act).toBeNull();
    expect(result.errors.join('\n')).toMatch(/未知 act/u);
  });

  it('缺少 act、act 非字符串、payload 非对象都被拒', () => {
    const noAct = userClaims();
    delete noAct.act;
    expect(checkSatClaims(noAct).ok).toBe(false);
    expect(checkSatClaims(userClaims({ act: 1 })).ok).toBe(false);
    expect(checkSatClaims(null).ok).toBe(false);
    expect(checkSatClaims([]).ok).toBe(false);
  });
});

describe('claim 取值校验', () => {
  it('tadm 必须是布尔', () => {
    expect(checkSatClaims(userClaims({ tadm: 'true' })).errors.join('\n')).toMatch(
      /claim tadm 取值不合法/u,
    );
  });

  it('pfx 每项必须以 / 开头结尾且不是 /', () => {
    expect(checkSatClaims(userClaims({ pfx: ['/api/app'] })).ok).toBe(false);
    expect(checkSatClaims(userClaims({ pfx: ['/'] })).ok).toBe(false);
    expect(checkSatClaims(userClaims({ pfx: 'x' })).ok).toBe(false);
  });

  it('dig / aph 必须是 64 位小写 hex', () => {
    expect(checkSatClaims(agentClaims({ dig: 'ABC' })).ok).toBe(false);
    expect(checkSatClaims(agentClaims({ aph: 'x'.repeat(64) })).ok).toBe(false);
  });

  it('jti 短于 128 bit 被拒', () => {
    expect(checkSatClaims(userClaims({ jti: 'short' })).errors.join('\n')).toMatch(
      /claim jti 取值不合法/u,
    );
  });

  it('时间戳必须是正整数秒', () => {
    expect(checkSatClaims(userClaims({ exp: '1788540300' })).ok).toBe(false);
    expect(checkSatClaims(userClaims({ nbf: 1.5 })).ok).toBe(false);
  });
});

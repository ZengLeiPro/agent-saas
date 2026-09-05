/** §9.2 强制范式片段生成器：内容来自常量，不得与实现漂移。 */
import { describe, expect, it } from 'vitest';

import {
  ADMIN_REQUIRED_MENU_KEY,
  CAPABILITY_RESPONSE_MAX_BYTES,
  HTTP_HEADERS,
  RESERVED_PATH_PREFIXES,
} from './types/constants.js';
import { MANDATORY_PATTERNS, renderClaudeMdContractSection } from './claudeMd.js';
import { validateConformance } from './schemas/index.js';

describe('renderClaudeMdContractSection', () => {
  it('§9.2 七条范式逐条出现', () => {
    const text = renderClaudeMdContractSection({ systemId: 'demo-erp', name: '演示 ERP' });
    expect(MANDATORY_PATTERNS).toHaveLength(7);
    for (const [index] of MANDATORY_PATTERNS.entries()) {
      expect(text).toContain(`${String(index + 1)}. **`);
    }
    expect(text).toContain('声明式权限表');
    expect(text).toContain('service 层共用');
    expect(text).toContain('ctx` 只由验签中间件构造');
    expect(text).toContain('禁止 handler 内 `fetch` 自身 HTTP');
    expect(text).toContain('403');
    expect(text).toContain(ADMIN_REQUIRED_MENU_KEY);
    expect(text).toContain(HTTP_HEADERS.permVersion);
  });

  it('常量取自 contract，不写死字面量', () => {
    const text = renderClaudeMdContractSection();
    expect(text).toContain(String(CAPABILITY_RESPONSE_MAX_BYTES));
    for (const prefix of RESERVED_PATH_PREFIXES) expect(text).toContain(prefix);
    expect(text).toContain('<systemId>');
  });

  it('标题层级可调，且是可追加的纯文本', () => {
    expect(renderClaudeMdContractSection({ headingLevel: 3 })).toContain('### 开沿定制项目契约');
    expect(renderClaudeMdContractSection().startsWith('## ')).toBe(true);
    expect(renderClaudeMdContractSection()).not.toContain('undefined');
  });

  it('客户面术语纪律：不写英文 Skill、不写「上游」', () => {
    const text = renderClaudeMdContractSection();
    expect(text).toContain('客户可见文案用「技能」');
    expect(text).toContain('不写英文 Skill');
  });
});

describe('附录 J 夹具的 menuApis（§9.3-8）', () => {
  const base = {
    contractVersion: 1 as const,
    users: { admin: { sub: 'a' }, member: { sub: 'b' }, norole: { sub: 'c' } },
    capabilities: {},
    endpoints: ['/'],
  };

  it('可选字段，合法时通过', () => {
    expect(validateConformance(base).ok).toBe(true);
    expect(
      validateConformance({
        ...base,
        menuApis: { orders: { method: 'GET', path: '/api/app/orders' } },
      }).ok,
    ).toBe(true);
  });

  it('method 只接受 GET/POST，且不允许多余字段', () => {
    expect(
      validateConformance({ ...base, menuApis: { orders: { method: 'PUT', path: '/x' } } }).ok,
    ).toBe(false);
    expect(
      validateConformance({
        ...base,
        menuApis: { orders: { method: 'GET', path: '/x', extra: 1 } },
      }).ok,
    ).toBe(false);
  });
});

/** 浏览器安全子集入口：导出面与「不依赖 Node / ajv」这条约束。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as browserEntry from './browser.js';
import { CONTRACT_VERSION, MESSAGE_NAMESPACE, normalizeAppPath } from './browser.js';

/** 依赖 node:crypto / Buffer / ajv 的模块，一律不得出现在浏览器入口的依赖图里。 */
const NODE_ONLY_MODULES = ['./hash.js', './manifest.js', './me.js', './schemas/index.js'];

describe('browser 子集入口', () => {
  it('只再导出 types / path / errors 三个模块', () => {
    const source = readFileSync(fileURLToPath(new URL('./browser.ts', import.meta.url)), 'utf8');
    for (const forbidden of NODE_ONLY_MODULES) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("export * from './types/index.js'");
    expect(source).toContain("export * from './path.js'");
    expect(source).toContain("export * from './errors.js'");
  });

  it('SDK 需要的常量与路径规范化都在', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(MESSAGE_NAMESPACE).toBe('ky');
    expect(normalizeAppPath('/orders/?ky=1&b=2&a=1')).toBe('/orders?a=1&b=2');
    expect(browserEntry.MESSAGE_RESPONSE_TIMEOUT_MS).toBe(5000);
    expect(browserEntry.HANDSHAKE_READY_TIMEOUT_MS).toBe(10_000);
  });
});

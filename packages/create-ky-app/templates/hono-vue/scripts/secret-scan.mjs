#!/usr/bin/env node
/**
 * pre-commit 密钥扫描（§8.4）：`.env` 真值、私钥 PEM、`Bearer ` 字面量一律拦下。
 * 与 `ky-app doctor` 第 14 章共用 `@kaiyan/ky-app-cli` 里的同一套规则。
 */
import { formatFindings, scanSecrets } from '@kaiyan/ky-app-cli';

const root = process.argv[2] ?? process.cwd();
const findings = await scanSecrets(root, { allowBearerIn: ['__tests__/'] });

if (findings.length === 0) {
  console.log('密钥扫描通过：没有发现 .env 真值、私钥或令牌字面量。');
  process.exit(0);
}

console.error(`密钥扫描发现 ${findings.length} 处问题，提交已被拦下：`);
console.error(formatFindings(findings));
console.error('');
console.error('凭据只能从密钥管理注入；示例请写进 .env.example。');
process.exit(1);

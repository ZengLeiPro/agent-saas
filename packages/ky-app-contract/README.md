# @kaiyan/ky-app-contract

开沿定制项目与 KY Agent 衔接契约的**共用实现**：JSON Schema、TypeScript 类型、
Canonical JSON（RFC 8785 JCS）、`aph()` 与 manifest digest、路径规范化、
manifest / `/me` 语义校验、SAT claims 矩阵与端点 × act 授权矩阵、错误码、附录 I 向量。

KY Agent 平台侧（签发端）与定制项目侧（验签端）共用本包，消除契约漂移。

## 安装

第一期发布产物是 `pnpm pack` tarball（Release 附件）：

```bash
npm i ./kaiyan-ky-app-contract-0.1.0.tgz
```

## 用法

```ts
import { aph, canonicalize, validateManifest, isEndpointAllowed } from '@kaiyan/ky-app-contract';

aph({ cap: 'order.create', input: { customerId: 'C001', lines: [{ qty: 2, sku: 'A-1' }] } });
// => 'ce4fb584cb7e1e50362f109ac42b140a55514ffd32683df207bb86bd10f31e89'
```

JSON Schema 文件同时以子路径导出，供非 TypeScript 消费方直接读取：

```ts
import manifestSchema from '@kaiyan/ky-app-contract/schemas/ky-app-manifest.v1.json' with { type: 'json' };
```

## 规范来源

`assets/20260905/开沿定制项目与KY Agent衔接契约-实施终稿.md`
（§3.1～3.3、§4.5、§5.2、§5.3、§6.5、§9.1、附录 A/B/C/D/I/J/L）。

## 脚本

| 命令             | 说明                                      |
| ---------------- | ----------------------------------------- |
| `pnpm typecheck` | `tsc --noEmit`                            |
| `pnpm test`      | vitest（含附录 I 六个向量与三个拒绝向量） |
| `pnpm build`     | 产出 `dist/`（JS + d.ts + schema JSON）   |

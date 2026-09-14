# KY App V2 JOSE 契约测试向量

本目录冻结 WP0 的跨实现输入和期望结果。`positive.json` 包含由两把不同测试密钥签署的 enrollment request、installation grant、client assertion、workload access token、token endpoint DPoP proof、资源请求 DPoP proof 和 attest；`negative.json` 描述必须 fail closed 的变体。

这些密钥和 token 只用于公开测试，永远不能作为开发、Staging 或 Production 凭据。fixture 不包含私钥；所有签名只能用随 fixture 保存的公钥验证。

## 消费约定

1. 先按 UTF-8 读取 compact JWS，拒绝非三段结构、padding、重复 JSON key和未知 critical header。
2. 根据调用的专用 verifier 选择唯一允许的 `typ`、算法和 key source，不能根据不可信 header 自动切换验证器。
3. 验证签名后，再校验 fixture 中 `expected` 指定的 issuer、audience、时间、HTTP、安装绑定和 scope。
4. `negative.json` 的 `mutation` 是确定性变换；平台与 SDK 必须产生对应 `expectedError`，不得只断言“抛出任意异常”。
5. 时间相关用例将验证时钟固定为 `2026-09-14T00:00:30Z`。DPoP `htu` 按 RFC 9449 排除 query/fragment，再执行 scheme/host 小写和默认端口消除的规范化比较；callback 则与已验证 origin 下的固定完整 URL 精确匹配。
6. `context.pkceVerifier` 是公开测试材料；其 S256 结果必须等于 enrollment request 中的 `code_challenge`。
7. digest 统一为现有 KY App 契约使用的 64 字符小写 hex，不增加 `sha256:` 前缀。

运行 fixture 自检：

```bash
pnpm --filter @kaiyan/ky-app-contract test:v2-vectors
```

自检证明 fixture 未损坏、正向签名有效、PKCE/DPoP/digest 的跨向量绑定一致，以及负向用例定义完整；它不替代 WP1 对负向变换和稳定错误码的语义 validator 测试。

## 负向变换格式

- `replaceProtected`：替换 protected header 字段后重新编码，但保留原签名，用于证明签名或 header 检查拒绝。
- `replacePayload`：替换 payload 字段后重新编码，但保留原签名。
- `resignWith`：WP1 harness 用指定测试 signer 对变体重新签名，用于验证“签名正确但语义错误”。fixture 不分发私钥，因此此类用例的 `source` 和完整目标值构成规范，WP1 生成端持有仅测试用 signer。
- `requestContext`：JWS 不变，只改变 method、URI、token、installation 或验证时钟等外部上下文。
- `replay`：对同一个已成功 proof/assertion 再验证一次，要求持久化 replay store 拒绝。

## 固定身份

| 名称              | 值                                                                  |
| ----------------- | ------------------------------------------------------------------- |
| 平台 issuer       | `https://agent.staging.example.com`                                 |
| 平台 API audience | `ky-app-platform-api`                                               |
| token endpoint    | `https://agent.staging.example.com/api/app-contract/v2/oauth/token` |
| tenant            | `tenant-vector-001`                                                 |
| installation      | `ins-vector-001`                                                    |
| system            | `system-vector-001`                                                 |
| deployment        | `deployment-vector-001`                                             |
| business origin   | `https://business.staging.example.com`                              |
| callback          | `https://business.staging.example.com/ky/v2/enrollment/callback`    |

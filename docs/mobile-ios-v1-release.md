# iOS V1 构建与提交

## 已冻结身份

- Expo/EAS：`@zengleipro/agent-saas`，project ID `2995ef56-aea4-4a59-ae4e-9ec3f203651a`
- Apple Team：`T4D4M5B485`
- 主 App Bundle ID：`com.agentsaas.mobile`
- App Store Connect App ID：`6808382989`
- Share Extension Bundle ID：`com.agentsaas.mobile.share-extension`
- App Group：`group.com.agentsaas.mobile.share`
- 首版：`1.0.0 (1)`
- 生产 API/WSS：`https://api.agent.kaiyan.net`、`wss://api.agent.kaiyan.net`

这些身份属于 Agent SaaS 新 App，不得替换为 KY Agent 的 App Store Connect App ID、Bundle ID、App Group、EAS project 或 provisioning profile。生产版 Connections/OAuth 不在 V1 范围内，因此生产 OAuth callback 明确关闭。

## 发布边界

1. 发布源必须是干净提交，而且已包含在 `origin/main`。
2. 构建只生成并验证 IPA，不提交；默认不清理全局构建缓存。
3. IPA 必须通过主 App 身份、版本、受签名保护的 source Git SHA、Distribution 签名、App Group、唯一 Share Extension 及 Extension 身份/签名校验；任一 target 意外带入开发或推送 entitlement，直接拒绝。
4. 提交脚本只接受 `mobile/builds/` 下带 source/verification sidecar 的已验证 IPA，并从当前 `main` manifest 重建身份、复制到私有快照后重新验签，再逐字节比对验证结果；上传时使用已验文件的匿名只读描述符，路径替换不能改变上传字节。
5. App Store Connect API key、Apple 登录凭据和 EAS token 不进入仓库。

## 命令

在仓库根目录、合并后的 `main` 提交上执行：

```bash
pnpm mobile-contract
pnpm --filter mobile build:ios:only
pnpm --filter mobile submit:ios builds/AgentSaaS-1.0.0.ipa
```

只有确实需要释放本机 Xcode/CocoaPods 缓存时，才直接执行 `mobile/scripts/build.sh ios --build --clean`。

## 暂缓项

- 最低/最新 iOS 真机矩阵、弱网、后台恢复、系统分享等 RC 验收暂缓，不得写成已通过。
- App Store 隐私问卷、截图、文案、审核说明及公开发布暂缓；TestFlight/处理成功不等于公开上架条件完成。

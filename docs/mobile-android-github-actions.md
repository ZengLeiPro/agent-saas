# Android 企业 APK（GitHub Actions）

## 运行边界

`.github/workflows/mobile-android-release.yml` 是内部企业 **APK 侧载**入口（包名
`com.agentsaas.mobile`）。v1 **不**提交 Google Play / AAB，**不**走 MDM publish，
**不**启用企业 OTA updater。

| 模式 | Secrets | 产出 |
| --- | --- | --- |
| PR `contract` | 无 | 单元/契约测试、企业清洁预构建、Gradle release fail-closed |
| Dispatch `仅构建企业 APK` | Environment `mobile-build-android-enterprise` | 签名 APK 工作流制品（人工下载侧载） |

编译使用 `mobile/scripts/build.sh android --distribution enterprise` → EAS 本地
`production-enterprise` profile（`credentialsSource: local`）。签名 fail-closed 行为由
`mobile/plugins/withAndroidSigningConfig.js` 保证，本流程不得放宽。

## 固定身份与版本

- 包名 / marketingVersion / `androidVersionCode`：`mobile/release-manifest.json`
- v1：`version.androidVersionCode = 1`，`target.distribution = enterprise`，
  `verification.distribution = verified`；`latestPublished.androidVersionCode` 在首次接受后再人工写入
- 生产 API/WSS：`mobile/eas.json` 的 `build.production` 与 `build.production-enterprise`
  公共 `EXPO_PUBLIC_MOBILE_*` 键；构建前 `load-android-production-config.sh` 也会导出

## GitHub Environment（人工，合并后）

创建 **`mobile-build-android-enterprise`**（与 iOS `mobile-build-production` 隔离）：

- 保护：仅 `main`；无 required reviewer；无 wait timer
- Secrets：
  - `ANDROID_RELEASE_KEYSTORE_BASE64`
  - `ANDROID_RELEASE_STORE_PASSWORD`
  - `ANDROID_RELEASE_KEY_ALIAS`
  - `ANDROID_RELEASE_KEY_PASSWORD`
  - 可选 `EXPO_TOKEN`（组织机器人；仅当 EAS CLI 本地构建要求登录时）

禁止把 keystore / `credentials.json` / 明文口令提交进 git。证书 SHA-256 记在私有 ops 日志。

## 日常操作

1. 合并启用 PR 且 main CI 绿。
2. 配置上述 Environment secrets（一次性）。
3. Actions →「Android 企业 APK 构建」→ 分支 `main` → 操作「仅构建企业 APK」。
4. 下载 artifact `android-enterprise-apk-<sha>-<run>-<attempt>` 中的
   `AgentSaaS-enterprise-<versionCode>.apk`。
5. 侧载：`adb install -r AgentSaaS-enterprise-1.apk`（或文件分发）。
6. 接受后跟进提交：把 `latestPublished.androidVersionCode` 设为本次 N；下次发版人工 +1。

```bash
gh workflow run mobile-android-release.yml --ref main \
  -f operation='仅构建企业 APK'
```

## PR contract 证明什么 / 首次签名 dispatch 证明什么

- **PR contract**：无密钥；证明清单企业门禁、EAS profile 形状、签名插件 fail-closed、企业预构建可生成、
  Gradle release 在缺 `ANDROID_RELEASE_*` 时失败。
- **首次签名 dispatch**：Environment secrets 齐全时产出可安装签名 APK；证明 keystore 物化、
  ephemeral `credentials.json`、EAS local、制品上传与清理。缺密钥时 job 失败关闭，不提供“未签名 release APK”旁路。

## 相关文档

- 凭据事故 / 轮换：`docs/mobile-android-credential-incident-runbook.md`
- iOS 对照：`docs/mobile-ios-github-actions.md`

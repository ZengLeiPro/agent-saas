# M60-03 原生 prebuild 与制品静态门禁

## 权威真源与边界

- 发布身份、release profile、Store/Enterprise 分发：`mobile/release-manifest.json`、`mobile/scripts/release-manifest.cjs`、`mobile/eas.json`。
- Android signer：`mobile/plugins/withAndroidSigningConfig.js`；release 只能引用外部 `signingConfigs.release`。
- 权限、backup、ATS、PrivacyInfo：`mobile/app.json`、`mobile/plugins/withMobilePrivacyControls.js`。
- M60-03 不创建第二份业务配置；`native-policy-lib.mjs` 读取上述真源，并检查 **Expo clean prebuild 后的实际原生树**。

## 运行

```bash
pnpm -F mobile test:m60-03
pnpm -F mobile test:m60-03:prebuild
```

`run-native-prebuild-gate.mjs` 从 `mobile/` 源项目复制到 OS 临时目录，在隔离副本中依次生成 iOS、Android Store、Android Enterprise。源工作树不会创建 `ios/` 或 `android/`。仓库没有真实 Apple team/app-group、provisioning 或 Android keystore 时，门禁只使用显眼的 test fixture 身份，并在 JSON 和人类摘要中标记 `releaseEvidence=false` 与 `non-release-evidence(test-fixture)`；这不能作为发布签名证据。

直接检查已有生成树：

```bash
node mobile/scripts/check-native-policy.mjs \
  --root /path/to/generated-mobile-root \
  --profile ios \
  --json /safe/output/ios.normalized.json \
  --evidence release \
  --team-id "$MOBILE_IOS_APPLE_TEAM_ID" \
  --app-group "$MOBILE_IOS_SHARE_APP_GROUP"
```

profile 只能是 `ios`、`store`、`enterprise`。输入树出现 symlink 或 `..` traversal 会 fail closed。报告只包含 `<generated-root>` 相对路径、规范化安全字段、bounded golden drift 和 correlation id，不写 provisioning、keystore、密码、token 或绝对路径。

## Golden 审批

Golden 保留 bundle/package ID、URL schemes、权限、entitlements、PrivacyInfo reasons、exported components、network/backup、release signer、distribution、artifact type 与 buildType；仅移除绝对路径、时间、文件顺序等噪音。

政策变更必须在代码审查中显式执行并提交 diff：

```bash
M60_03_UPDATE_GOLDEN=1 node mobile/scripts/run-native-prebuild-gate.mjs \
  --profile all --update-golden
```

没有 `M60_03_UPDATE_GOLDEN=1` 时脚本拒绝更新。CI 永不更新 golden，只比较。

## CI 证据边界

required `Preflight / Mobile + native E2E contract` 运行 mutation tests、三 profile clean prebuild、checker 和既有 mobile contract。失败时只上传 `.ci-artifacts/native-policy/*.json` 的有限规范化 JSON/diff；不上传原始 plist、entitlements、provisioning 或签名材料。

clean prebuild 是源码生成树静态证据，不替代 archive/AAB/APK 的 merged manifest、codesign/签名校验、真机权限、backup/restore 与商店审查。

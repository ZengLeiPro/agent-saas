# iOS 自动构建与 TestFlight 发布

## 运行边界

`.github/workflows/mobile-ios-release.yml` 是 iOS 内部测试发布入口。正常发版只手动触发一次，默认操作
`build-and-testflight`，依次完成：

1. 校验完整 `main` source SHA 及该提交最新一次 push-main `Build & Check`。
2. 分配唯一构建号 `<manifest 基数>.<GitHub run ID>.<attempt>`。
3. 在 GitHub 托管 `macos-15` runner 上运行 `expo prebuild`、CocoaPods 和 `xcodebuild`。
4. 用独立的主应用、Share Extension App Store 描述文件签名并生成 IPA。
5. 复核两个 Target 的 Bundle ID、Team、App Group、版本、构建号、签名和 entitlement，保存不可变制品。
6. 用 Apple 原生命令上传同一份 IPA，等待 App Store Connect 处理为 `VALID`。
7. 核对 `kaiyan` 为自动接收所有构建的内部测试组，等待新构建进入 `IN_BETA_TESTING`。

编译、签名和上传均不依赖 EAS 云构建、EAS 凭据托管或 EAS Submit。Expo SDK、React Native
及 Android 现有 EAS 配置不受影响。

Workflow 到内部 TestFlight 可用即结束，不关联正式 App Store 版本，不创建审核提交，也不触发公开上架。
`kaiyan` 组已开启自动接收所有构建；组内成员会按现有通知设置收到更新并可在 TestFlight 下载。

## 固定身份

Apple Team ID、App Store Connect App ID、主 Bundle ID、App Group 和版本基数均读取
`mobile/release-manifest.json`。Share Extension Bundle ID 固定为主 Bundle ID 加
`.share-extension`。生产 API/WSS 地址继续读取已审查的 `mobile/eas.json` production 公共配置，
但 iOS 流程不调用 EAS。

## GitHub 环境

### `mobile-build-production`

Secrets：

- `IOS_DISTRIBUTION_P12_BASE64`
- `IOS_DISTRIBUTION_P12_PASSWORD`
- `IOS_APP_PROFILE_BASE64`
- `IOS_SHARE_PROFILE_BASE64`

### `mobile-submit-ios-testflight`

Secret：

- `APP_STORE_CONNECT_API_KEY_P8`

Variables：

- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

API key 只用于上传构建并读取目标 App 的 TestFlight 状态。
`.p8` 只能在 Apple 创建 key 时下载一次。已经托管在 EAS 的 key 可以看到 ID 和 issuer，但不能导出私钥。

两个环境都必须配置为：

- 无 required reviewer、无 wait timer；
- 仅允许 `main` 分支，不允许 tag；
- Secret 只对各自 job 开放。

正常路径的唯一人工授权是点击 `Run workflow`。环境用于凭据隔离和 main-only 限制，不再增加第二、
第三次审批。脚本会通过 GitHub API 回读环境规则；发现 reviewer、宽泛分支策略或读不到规则时直接停止。

## 一次性初始化

在持有签名材料和 App Store Connect `.p8` 的受控电脑上运行：

```bash
bash mobile/scripts/init-ios-github-release.sh \
  --credentials-json /受控路径/credentials.json \
  --api-key-p8 /受控路径/AuthKey_XXXXXXXXXX.p8 \
  --api-key-id XXXXXXXXXX \
  --issuer-id XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
```

不带 `--apply` 只做本地预检；确认无误后追加 `--apply` 才会创建环境并写入加密设置。脚本自动完成
P12/profile 的 Base64 转换，不打印密码、私钥或 Secret 值。

只有签名材料、尚无 `.p8` 时可先配置构建环境：

```bash
bash mobile/scripts/init-ios-github-release.sh \
  --credentials-json /受控路径/credentials.json \
  --build-only \
  --apply
```

这不会创建伪造的上传凭据，也不会触发上传。

## 日常发布

在 Actions 选择“iOS 构建与发布”，保留默认 `build-and-testflight`，`source_sha` 留空并运行。
Workflow 使用调度时的 `main` SHA，完成构建、上传、Apple 处理确认和内部组分发。构建与发布仍是两个 job，
这是凭据隔离，不是两次人工审批。

`build` 只生成并保存已签名 IPA，不上传。`testflight` 用于上传或 Apple 处理失败后的恢复：填写原构建摘要中的
完整 `source_sha`、`build_run_id` 和 `build_run_attempt`。它只下载该次成功构建保存的 artifact，
重新验签后上传，不重新构建。若 Apple 已收到相同版本和构建号，脚本跳过二次上传并继续查询处理及内部测试状态。

IPA artifact 保留 7 天，提交状态回执保留 30 天。过期后不静默重建旧构建；应明确发布新构建。

## 正式上架边界

本 Workflow 不读取、不自动编造或覆盖以下正式上架资料：

- App 名称、副标题、介绍、关键词、支持与隐私网址；
- 分类、年龄分级、价格与销售地区；
- 各尺寸截图或预览；
- 隐私问卷、出口合规和内容权利答案；
- 审核说明及确有需要时的审核账号。

这些资料不阻断内部 TestFlight。将来准备正式上架时，应另行实现和授权 App Review 流程；当前 Workflow
不会读取 `APP_REVIEW_DEMO_USERNAME`、`APP_REVIEW_DEMO_PASSWORD` 等审核资料。

## 可验证边界

PR 的 macOS job 不接触发布 Secret，不上传 Apple。它会安装锁定依赖、生成真实 Xcode 工程、安装 Pods，
并验证主应用与 Share Extension 均能被精确配置为手动签名。合并后的第一次真实 dispatch 才能证明：

- GitHub runner 能用现有证书和两个描述文件生成已签名 IPA；
- Apple 上传及处理查询成功；
- Apple 能将新构建自动分发给 `kaiyan` 内部组；
- 组内成员能在 TestFlight 收到并安装更新。

PR 绿灯、Secret 名称存在或本地脚本通过，都不能替代上述真实结果。

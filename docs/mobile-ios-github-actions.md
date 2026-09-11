# iOS 自动构建与 TestFlight 发布

## 运行边界

`.github/workflows/mobile-ios-release.yml` 是 iOS 内部测试发布入口。正常发版只手动触发一次，默认操作
「构建并发布到 TestFlight」，依次完成：

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

## 日常发布：两项表单，默认直接运行

在 Actions 选择「iOS 构建与发布」，分支保留 `main`。只保留以下两项：

| 表单项 | 正常发布 | 故障恢复 |
| --- | --- | --- |
| 执行操作（`operation`） | 默认「构建并发布到 TestFlight」 | 选择「重试已有构建的发布」 |
| 原构建运行链接或编号（`build_run`） | 留空 | 粘贴原构建运行链接或纯数字编号 |

另外保留「仅构建，不发布」，只生成并保存已签名 IPA。GitHub 表单仍会显示第二项，
但仅重试时填写；系统会拒绝「新构建 + 原运行编号」以及「重试 + 未填原运行」的组合。

新构建固定使用点击运行时的 `main` SHA，不再手填 `source_sha`。若该提交的 push-main CI
尚未出现或未结束，准入步骤每 15 秒查询一次，最多等待 20 分钟（job 总超时 25 分钟）。
只认可该提交最新一次 CI/attempt 和 `Build & Check`；CI 失败立即终止，超时明确报错。
等待期间不会跟随 main 更新，也不会退回旧的绿色提交。构建和发布阶段仍各自复核授权。

构建与发布仍是两个 job，用于凭据隔离，不需要两次人工审批。

## 重试发布：只粘贴原运行

选择「重试已有构建的发布」，在 `build_run` 填写原**签名构建**运行，例如：
`https://github.com/ZengLeiPro/agent-saas/actions/runs/123456789` 或 `123456789`。
也可粘贴该运行的 `/job/...` 页面链接；它引用整次运行，不把页面中的 Job ID 当作 Run ID。
不接受其他仓库、非 GitHub 域名、`/attempts/...` 链接或本次新运行自身。

系统分页读取原运行制品，以制品命名中的源码 SHA 和 attempt 为候选，再查询该**精确 attempt**
的已成功签名构建任务，并核对仓库、工作流、main、事件类型、制品归属与 digest。
不会用最新 attempt 代替真正产生 IPA 的 attempt，也不会用原 workflow SHA 代替应用源码 SHA。
过期制品和失败构建不是可用候选；找不到候选或有多个可用 IPA 时明确停止，不猜测、不重建。
同一原运行正在重跑或解析期间发生重跑，也会停止。

计划锁定唯一制品的 ID、digest、workflow SHA。下载前再次核对这些绑定值，下载后继续核对
`ios-release.json` 中的源码、attempt、版本和文件哈希，并执行原有签名/应用身份校验，最后才上传。
即使后来 main 已前进，重试仍检出原 IPA 对应的源码。只上传原 IPA，不调用任何构建步骤。
若 Apple 已收到相同版本和构建号，上传程序沿用原有幂等查询逻辑。

IPA artifact 保留 7 天，提交状态回执保留 30 天。过期或无法唯一解析时，应明确发起一次新的构建发布。
上传失败后，推荐新建「重试已有构建的发布」运行，而不是对整条旧 Workflow 执行 Re-run。
旧四参数 API/CLI 调用也必须迁移；删除的 `source_sha`、`build_run_id`、`build_run_attempt` 不作为隐藏覆盖项接受。

```bash
# 正常发布，无需填写输入（读取 Workflow 默认值）
gh workflow run mobile-ios-release.yml --ref main

# 仅重试原构建的发布
gh workflow run mobile-ios-release.yml --ref main \
  -f operation='重试已有构建的发布' \
  -f build_run='123456789'
```

本次表单简化不新增 Secrets，不修改两套 Environment、原有签名门禁或正式上架边界。
自动解析与等待逻辑通过 `node --test mobile/scripts/ios-release-inputs.test.mjs` 验证；
测试使用模拟 GitHub API、真实 Git/CLI/文件处理，不触发真实签名或 Apple 发布。

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

# iOS 构建与发布：GitHub Actions 操作手册

## 范围与入口

入口是 `.github/workflows/mobile-ios-release.yml`，在 Actions 中显示为 **iOS 构建与发布**。
本次只接入 iOS production 的签名构建、IPA 校验、制品保存和 App Store Connect / TestFlight 提交。
Android、真机 RC、Apple 审核决定、App Store 正式放量和 M70 rollout 不在这个入口中执行。

编译发生在 GitHub 托管的 `macos-15` runner，使用 `eas build --local`。签名凭据仍从 EAS
读取，上传仍由 EAS Submit 完成。因此不需要自备 Mac 构建服务器，但这不是完全脱离 Expo 云服务的方案。
现有 `mobile/scripts/build.sh` 和 `mobile/scripts/submit-ios.sh` 的本地使用方式不变。

PR 只执行无发布凭据的脚本契约测试和真实 macOS 工具链检查；主 CI 还会运行现有完整移动端测试。
**这些检查通过不代表真实签名构建或商店上传已经发生。** 仓库合并 PR 不会自动上传 App。

## 首次启用：受保护环境

合并本 PR 后，由仓库管理员在 Settings → Environments 创建以下环境：

| Environment | Variables | Secrets |
| --- | --- | --- |
| `mobile-build-production` | `MOBILE_RELEASE_CONFIGURED=true` | `EXPO_ORG_ROBOT_TOKEN` |
| `mobile-submit-ios-store` | `MOBILE_SUBMIT_CONFIGURED=true` | `EXPO_ORG_ROBOT_TOKEN` |

每个环境都必须配置：

1. 至少一位 required reviewer，启用 **Prevent self-review**。
2. 禁用 **Allow administrators to bypass configured protection rules**。
3. Deployment branches and tags 选择 protected branches，或者只允许 branch `main` 的自定义策略；不要允许 tag 或通配符。

发起运行和重跑的人不能审核自己的运行。构建与提交各自审批，可以由同一位独立审核人在两个阶段分别批准。
请在审批前核对 run name 和 plan summary 中的完整 source SHA、操作和原构建 run/attempt。

Workflow 会从 GitHub API 读取实际保护规则和批准历史，校验并记录规则摘要；读不到、未配置、
被放宽、缺少独立批准时均停止，不使用手工写入的“已批准”标志代替真实审批。
仅使用最小的 contents/actions/deployments 读取权限，不申请修改源码或仓库设置的令牌。
配置开关在环境设置完成后才设为 true；不能为了让任务变绿而移除审批检查。

## 首次启用：Expo 和 Apple 凭据

两个环境中的机器人令牌都必须能访问 `mobile/release-manifest.json` 中指定的 EAS project 和 owner。
当前采用 **EAS 托管凭据**，不把 Apple 账号密码、证书、描述文件或 `.p8` 提交到 Git。
令牌名称本身不能证明它属于机器人，管理员必须核实所属身份和权限；不得用个人令牌冒充组织机器人。
若项目当前仍归个人账户，需先完成经批准的组织归属/机器人访问配置，并通过 PR 同步真实 owner；
本 Workflow 不会转移项目、修改 Apple 团队或猜测生产凭据。

在受控工作站中，用有权管理该项目的账号完成一次配置：

```bash
pnpm install --frozen-lockfile
cd mobile
pnpm exec eas credentials --platform ios
```

选择 production，核对并配置主 App 与 Share Extension 的 distribution certificate 和
App Store provisioning profile，以及正确的 App Group、Keychain Group 和生产 APNs entitlement。
再选择 **App Store Connect: Manage your API Key → Set up your project to use an API Key for EAS Submit**。
确认关联的是 manifest 指定的独立 App Store Connect App，而不是其他历史 App。

`eas submit --non-interactive` 从该项目的 EAS 配置读取 App Store Connect API key。
本入口不额外要求把 `.p8` 放到 GitHub Secrets，也不会临时修改已审核的 `eas.json`。
未配置远程提交 key 或令牌无权访问时，提交将明确失败，不能退回交互式 Apple ID/2FA 登录。
EAS Secret 级环境变量不会自动用于 local build；新增实际必需的 secret 时必须经过审查并显式绑定到对应步骤。

## 工具链与版本

使用 Xcode 26.2 / iPhoneOS SDK 26.2，显式选择 `/Applications/Xcode_26.2.app/Contents/Developer`。
`mobile/eas.json` 的云镜像同步为 `macos-sequoia-15.6-xcode-26.2`。
`--local` 不会替你选择这个镜像，因此 `setup-ios-runner.sh` 还会检查 runner 的实际版本；
缺少固定 Xcode 时停止，而不是偷偷使用默认版本。

Node.js 读取 `.nvmrc`，pnpm 读取根 `package.json`；锁文件安装使用 `--frozen-lockfile`，
EAS CLI 继续固定为 18.1.0。pnpm 的 macOS arm64/x64 下载文件使用官方 release SHA256 校验。
CocoaPods、fastlane 等使用 GitHub 镜像预装版本，实际版本、架构和 runner image version 写入制品记录；
GitHub 托管镜像本身会更新，不能把本流程描述为字节级可复现构建。

版本来自 `mobile/release-manifest.json`。新构建版本需要先通过 PR 更新 marketingVersion / iosBuildNumber，
并核对 Apple 已使用的 build number；Workflow 不在构建过程中自动修改 Git 文件、提交版本或递增远程版本。
iOS-only 不要求填写 Android versionCode 或解除 Android 的发布阻断项。

## 日常操作

在 Actions → iOS 构建与发布 → Run workflow 中选择 **main**。提供完整的、已合入 main 的 source SHA；
构建时留空会使用本次调度冻结的 main SHA，不会在后续阶段漂移到更新的 main。
来源必须通过最新一次同 SHA 的 push-main CI 和 `Build & Check`，PR CI 的绿灯不能替代该授权。
若 CI 还在运行或最新重跑失败，需要先让真实 CI 完成/修复，不能复用更早的绿灯。

### 仅构建

选择 `operation=build`。构建审批通过后，runner 安装依赖、运行 iOS 原生预构建策略检查、
构建签名 IPA，并验证主 App 和 Share Extension 的身份、权限、证书与源码 SHA。

成功后生成不可变 artifact：

```text
ios-ipa-<source_sha>-<build_run_id>-<build_run_attempt>
  AgentSaaS-<marketingVersion>.ipa
  AgentSaaS-<marketingVersion>.ipa.source.json
  AgentSaaS-<marketingVersion>.ipa.verification.json
  ios-release.json
```

`ios-release.json` 绑定 IPA/附件摘要、source SHA、workflow SHA、版本、lockfile/manifest 摘要、
main CI、真实审批与实际工具链。IPA 保留 7 天，不覆盖同名 artifact，不上传 EAS 临时目录、密钥或原始日志。
构建 run ID 和 attempt 在 summary 中显示；它们不是 EAS 的 build ID。

### 构建后提交

选择 `operation=build-and-submit`。构建成功并保存原包后进入独立的提交审批。
提交 job 使用新的 macOS runner，按原构建 artifact ID 下载 IPA，重新核验来源、版本、SHA256 和原生签名，
然后调用现有 `submit-ios.sh` 上传同一份 IPA；**提交 job 不会重新构建 App**。

EAS Submit 完成后保存 `ios-submit-<source_sha>-<submit_run_id>-<submit_attempt>` JSON 回执，保留 30 天。
回执只表示 EAS 提交成功，不表示 Apple 后续处理成功、审核通过或已经正式上架。

### 单独提交 / 上传失败后重试

选择 `operation=submit`，填写原构建 summary 中的完整 `source_sha`、`build_run_id`、`build_run_attempt`。
即使原来 build-and-submit 的提交阶段失败，只要对应 attempt 的签名构建 job 确实成功且 artifact 未过期，
仍可复用原包。系统校验原 workflow、main 分支、repository、attempt、job 结论和唯一 artifact ID，
拒绝 PR/fork、错 SHA、错 attempt、未完成构建、过期和被篡改的制品。

不要用“Re-run all jobs”代替上传重试，否则可能重新构建；应使用 submit-only 明确指定原记录。
若 Apple 已收到包但本地回执写入/保存失败，先查看 EAS / App Store Connect 的实际状态，再决定是否重试。
重复 build number 会被 Apple 拒绝，不能把这种拒绝伪装为成功，也不能自动换一个包继续上传。

过期 artifact 不会被悄悄重建。需要新包时应重新审核源码/版本并执行构建；发布同一旧包则需要原始可信记录和文件，
不能把任意手工上传的 IPA 当成这个 Workflow 的构建结果。

## 安全边界与现有 M60/M70

编排代码使用本次 main 的可信 checkout，应用源码在独立的 `source/` checkout；两者的 SHA 分开记录。
不会从下载的 artifact 运行脚本，不会把 PR 内容带进带生产 secret 的 job。
Expo token 只在实际构建或实际提交的步骤注入；依赖安装、来源校验和制品校验不持有该 token。
发布共用不可取消的并发锁，不会用新运行取消进行中的签名或上传。

这里的 `github-ios-build` / `github-ios-submit` 是有 GitHub run/artifact 来源的操作记录，
**不是**旧 M60-04 Ed25519 完整发布证据，也不能交给 M70 放量 validator 冒充 signed submit receipt。
原 M60/M70 的组织证据签名、provider reverse lookup、真机 RC、遥测和放量门禁保持不变；
本入口不设置 `MOBILE_ROLLOUT_CONFIGURED`，也不触发任何 rollout adapter。

## 参考

- Expo local builds：https://docs.expo.dev/build-reference/local-builds/
- Expo iOS submit 和远程 API key 配置：https://docs.expo.dev/submit/ios/
- Expo SDK 55 的 Xcode 26.2 镜像：https://docs.expo.dev/build-reference/infrastructure/
- GitHub macOS runner 工具清单：https://github.com/actions/runner-images/tree/main/images/macos
- pnpm 官方校验来源：https://api.github.com/repos/pnpm/pnpm/releases/tags/v10.18.3

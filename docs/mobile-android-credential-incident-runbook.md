# Android 发布凭证事件处置 Runbook（M00-02）

> 状态：**事件代码止血已实现，凭证轮换与签名连续性仍为 BLOCKED / 人工待办。**
>
> 适用包名：`com.agentsaas.mobile`（仅为仓库配置事实，不代表任何商店后台事实）。
>
> 原则：已入库的旧口令必须永久视为泄露；删除当前源码不能撤销 Git 历史、镜像或日志中的暴露。

## 1. 已知事实与不可伪造项

| 项目                             | 当前事实                                                                                                          | 完成标准                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 旧发布口令                       | 曾以明文进入版本库；本文不重复其值                                                                                | 凭证管理员完成轮换并提供回执                                   |
| 既有正式包 signer SHA-256        | **未核验（BLOCKED）**；仓库没有可信旧正式 APK/AAB、商店证书回执或可验证 keystore，代码中的 alias 不能替代证书指纹 | 从可信旧正式包/商店后台提取并由两人复核                        |
| 当前候选 keystore signer SHA-256 | **未核验（BLOCKED）**                                                                                             | 从轮换后的受控 keystore 和新制品分别提取，结果一致             |
| 旧包覆盖升级                     | **未执行（BLOCKED）**                                                                                             | 真实旧正式包在真实设备上被新候选包覆盖升级，应用数据与身份连续 |
| 口令轮换                         | **未执行（BLOCKED）**                                                                                             | 旧口令失效；新值只存在于批准的 secret store                    |
| 是否更换 key                     | **未决（BLOCKED）**                                                                                               | 凭证管理员、渠道 owner 和安全负责人根据商店签名能力书面决策    |
| 发布身份                         | 当前 EAS owner/个人 token 是否仍在用，仓库无法确认                                                                | 组织发布机器人接管，个人 token 被撤销并有审计回执              |

在以上人工证据齐全前，不得把 M00-02 的“签名连续性”“轮换”或“升级验证”标记为完成，也不得发布外部 RC。

## 2. 代码侧强制契约

`mobile/plugins/withAndroidSigningConfig.js` 只接受以下四个受控环境变量，没有默认值：

- `ANDROID_RELEASE_KEYSTORE_PATH`：secret store 临时物化或安全挂载的外部 keystore 文件路径；不得提交到仓库；
- `ANDROID_RELEASE_STORE_PASSWORD`；
- `ANDROID_RELEASE_KEY_ALIAS`；
- `ANDROID_RELEASE_KEY_PASSWORD`。

行为约束：

1. `expo prebuild --clean --no-install --platform android` 在没有凭证时仍可生成原生工程，供静态审计；
2. 生成的 `buildTypes.release` 必须引用 `signingConfigs.release`，不得引用 debug signer；
3. 生成的 Gradle 只保留环境变量读取表达式，不插入环境变量当前值，也不打印值或 keystore 路径；
4. 任一 release task 进入 Gradle task graph 时，缺变量、空变量或 keystore 不是普通文件均抛出 `GradleException`；debug/prebuild 不需要发布凭证；
5. `mobile/certs/`、`credentials.json`、`*.jks` 和 `*.keystore` 不得进入版本库。

自动化命令：

```bash
pnpm -F mobile test:android-signing
# 在有 JDK/Android 构建环境且上一步已生成 android/ 后执行：
pnpm -F mobile test:android-signing:gradle
pnpm -F mobile typecheck
```

第二条命令会主动清空四个签名变量并调用 Gradle 验证 task；只有观察到 M00-02 的预期非零失败才返回成功。它不会使用或打印真实凭证。

## 3. 立即遏制（凭证管理员 + 发布 owner，人工）

1. 暂停 Android release、提交与灰度；保存事件编号、开始时间和处置人。
2. 在 EAS、GitHub、CI、构建机和制品平台检索旧个人发布 token 的使用记录；先创建组织机器人/服务账号，再撤销个人 token。
3. 将旧 store/key password 标记为泄露并轮换。不得因“仓库当前已删除”而继续使用旧值。
4. 检查历史构建日志和 artifact 是否包含 Gradle 文件、环境转储、`credentials.json` 或 keystore；发现后按平台能力删除并记录审计事件。
5. 禁止在 shell 中启用 `set -x`，禁止 `echo` 密码，禁止把密码放入命令行参数、PR 评论、任务评论或截图。

## 4. 盘点既有正式 signer（必须先做）

### 4.1 取得可信旧制品

从商店后台、已批准制品库或已安装设备取得“当前用户实际可升级来源”的旧正式 APK。记录：渠道、包名、versionName/versionCode、下载来源、文件 SHA-256、取得人和时间。不要使用开发机随手找到的未溯源 APK。

```bash
sha256sum /secure/path/old-official.apk
apksigner verify --verbose --print-certs /secure/path/old-official.apk
```

必须记录 `Signer #1 certificate SHA-256 digest`。如使用 Google Play App Signing，必须分别记录：

- **App signing certificate**：用户设备上的包所用 signer；
- **Upload certificate**：上传 AAB/APK 的身份。

二者不可混写。若不是 Play 渠道，则记录该渠道实际分发包的 signer。

### 4.2 核对受控 keystore

在隔离构建机上执行，密码使用交互输入或批准的 secret injection；不要写 `-storepass` / `-keypass` 参数：

```bash
keytool -list -v \
  -keystore "$ANDROID_RELEASE_KEYSTORE_PATH" \
  -alias "$ANDROID_RELEASE_KEY_ALIAS"
```

将证书 SHA-256 与 4.1 的对应 signer 比较。**不一致时立即停止**；不得靠修改 alias、包名或 versionCode 绕过。先由渠道 owner 判断是否拿错 keystore、是否存在 Play App Signing，或是否必须走平台支持的 key rotation。

## 5. 轮换策略（人工审批）

1. **优先保留同一私钥/证书，仅轮换 keystore 与 key entry 口令。** 这通常维持非 Play APK 的覆盖升级连续性；轮换前后证书 SHA-256 应相同。
2. 是否更换私钥必须单独评估：
   - 普通 APK 直接换 signer 通常导致 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；
   - Play App Signing 的 app-signing key / upload key 轮换流程不同，必须使用 Play Console 支持的正式流程；
   - 不得因旧口令泄露就声称私钥已泄露，也不得因私钥文件未入库就声称私钥安全。
3. 轮换在受控工作站/HSM/secret manager 中完成，保留加密备份、owner、恢复演练和审批记录。
4. 将 keystore 作为受控 file secret 提供给 `ANDROID_RELEASE_KEYSTORE_PATH`，其余三个值设为 masked/secret；禁止把值写入 `eas.json`、workflow YAML、Gradle properties 或 shell 脚本。
5. EAS/GitHub 发布使用组织机器人 token（例如受保护的 `EXPO_TOKEN` secret），最小权限、到期时间和双人审批；个人 token 必须撤销。具体账号创建与 secret 写入只能由组织管理员完成。

## 6. 新制品与覆盖升级验证（人工）

### 6.1 构建与 signer 复核

在批准的 release 环境注入四个变量后执行 release 构建。命令行不得出现变量值。对最终 APK 执行：

```bash
sha256sum /secure/path/new-release.apk
apksigner verify --verbose --print-certs /secure/path/new-release.apk
```

核对包名、versionCode 单调递增、最终制品 signer SHA-256 与第 4 节批准结果一致。AAB 还需在目标商店生成/下载渠道实际 APK 后核对用户侧 app-signing certificate，不能只核对 upload key。

### 6.2 真实旧包覆盖升级

至少准备一台真实 Android 设备，先安装第 4 节的可信旧正式包并产生可识别的测试数据，再覆盖安装新包：

```bash
adb install /secure/path/old-official.apk
# 登录测试账号并产生可复核数据后：
adb install -r /secure/path/new-release.apk
adb shell dumpsys package com.agentsaas.mobile
```

验收必须同时满足：

- 无 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；
- 应用数据、登录/安全迁移和核心启动路径符合升级预期；
- `versionCode` 为新值；
- 设备实际安装包 signer 与批准的既有 signer 连续；
- 记录设备型号/系统版本、旧/新制品 SHA-256、旧/新 signer SHA-256、时间、执行人与结果。

Play 渠道必须再通过内部测试轨道完成一次商店下发升级；本地 `adb install -r` 不能替代商店签名链证据。

## 7. 人工回执模板

以下内容由凭证管理员、渠道 owner 和复核人填写并附到受控任务/审批系统，**不要把 secret 值粘贴进回执**：

```text
事件/审批编号：
渠道与包名：
可信旧制品 version / SHA-256：
既有用户侧 signer SHA-256：
旧 upload signer SHA-256（如适用）：
轮换决策：同 key 换口令 / 平台 key rotation / 其他
新制品 version / SHA-256：
新用户侧 signer SHA-256：
新 upload signer SHA-256（如适用）：
旧包覆盖升级设备、系统与结果：
组织发布机器人主体 / token 审计 ID：
旧个人 token 撤销审计 ID：
secret 更新审计 ID（不得含值）：
执行人 / 复核人 / 时间：
```

只有 signer 连续性、口令轮换、机器人身份和真实覆盖升级四项都有可核验回执，M00-02 人工 Gate 才可解除。

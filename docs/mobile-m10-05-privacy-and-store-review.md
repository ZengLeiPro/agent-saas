# M10-05 移动端权限、隐私与商店申报待确认清单

> 状态：**代码基线已实现，外部隐私与商店口径全部待人工确认。**
>
> 本文只区分可由仓库/生成物验证的代码事实与需要法务、产品、发布负责人确认的外部事实；不是隐私政策、Apple App Privacy 或 Google Data Safety 的已完成申报。

## 一、代码事实（可自动审计）

### 1. 权限触发

- V1 不提供设备定位能力：移动端不再依赖 `expo-location`，启动/前后台生命周期不上报位置字段，也不再展示活动日志位置入口。
- 冷启动、登录页和首屏没有麦克风、相机或图库权限请求。
- 麦克风仅在用户按下语音录制控件后请求；拒绝时不开始录音。
- 相机仅在用户选择“拍照”后检查/请求；拒绝时不启动相机。
- 图库选择器仅在用户选择附件/头像图库入口后打开。文字输入与发送路径不调用媒体权限 API，媒体权限被拒不阻断文字聊天。

### 2. Android 原生策略

- `android:allowBackup="false"` 为所有 profile 的主开关。
- 同时生成 deny-all 的 legacy full-backup 与 Android 12+ data-extraction rules，明确排除 cloud backup 和 device-to-device transfer 的 app 数据域；用于覆盖 SecureStore、AsyncStorage 中的消息/草稿/文件索引等本地状态。
- production 生成物强制 `android:usesCleartextTraffic="false"`，且不接受 network security cleartext 例外。
- development/preview 因 M10-01 仍允许构建时 allowlist 内的 HTTP 开发服务，Android cleartext 例外由 release profile 动态生成；production 不继承该例外。
- 有效权限限定为联网、振动、录音、相机及音频设置；Store 不含安装权限。Enterprise 也仅在经过 M10-04 校验的 updater 显式启用时含 `REQUEST_INSTALL_PACKAGES`。
- location、overlay、legacy/media storage、后台音频和 foreground-service 权限被阻断；Expo Audio/Video 的后台播放、后台录制和画中画均关闭。

### 3. iOS 原生策略

- 仅保留由用户动作触发的麦克风、相机、图库用途说明。
- 移除 Location/Face ID 用途键、后台 audio mode、定位日志地图入口配置。
- production 删除 Expo 默认 local-network ATS 例外及任意加载/exception-domain 类例外；development/preview 的 Expo 本地网络开发例外不进入 production。
- 主 App 通过 `ios.privacyManifests` 生成可审计的 `PrivacyInfo.xcprivacy` 基础结构：tracking=false，tracking domains、collected data types、required-reason API types 暂为空数组。
- 空数组表示“尚未取得人工/依赖审计结论”，**不表示 App Store 隐私申报已完成或应用不处理任何数据**。

### 4. 本地数据边界（代码事实，不等于保留政策）

仓库可见本地状态包括但不限于：

- SecureStore：认证凭据；
- AsyncStorage：消息缓存、聊天草稿、文件索引/列表缓存、用户与界面偏好等；
- app cache：下载文件与预览内容；
- 内存：预览 token 等短期状态。

M10-05 只关闭 Android 系统 backup/restore 通道，没有改变这些数据的业务保留期限，也没有实现身份缓存 v2。

## 二、人工待确认（均未完成）

- [ ] 对外隐私政策正文、公开 URL、主体名称、联系方式、生效日期与版本。
- [ ] Apple App Privacy：实际收集的数据类型、是否关联身份、用途、是否用于 tracking、第三方 SDK/服务端处理边界。
- [ ] Apple required-reason API：对主 App 及全部依赖/扩展做归档级扫描后，逐项确认 API category 与 Apple 允许的 reason code。当前主 App 文件故意不猜值。
- [ ] Google Play Data Safety：数据收集/共享、加密、删除请求、安全实践等答案。本文没有代填任何答案。
- [ ] iPad 支持口径。源码继承 `supportsTablet=true`，但未取得产品/QA 的支持承诺，不能据此宣称已支持。
- [ ] iOS/Android 最低系统版本、目标设备矩阵与商店兼容口径；应以正式发布配置和真机验收为准。
- [ ] 服务端及本地消息、草稿、文件、审计日志、凭据的保留期限、删除条件、备份保留和用户请求流程。
- [ ] Store 与 Enterprise 的地区、分发对象、更新责任与安装来源说明。
- [ ] 客户/个人数据是否交由第三方处理，以及适用的数据处理协议、跨境和子处理方清单。

## 三、发布前验证缺口与风险

- [ ] Android 真机：冷装并进入登录/首屏，确认系统权限面板未出现定位、麦克风、相机、相册请求。
- [ ] iOS 真机：同上，并逐一验证语音、拍照、图库在用户动作后才出现系统流程；拒绝后文字聊天正常。
- [ ] Android 真机或受控设备：执行真实 cloud backup / restore 与 device-to-device transfer 负向验证。M10-05 自动化只检查生成配置，**没有宣称真实 restore 已验证**。
- [ ] 对 archive/AAB/APK 的最终 merged manifest、entitlements 与 PrivacyInfo 再做一次发布制品检查；clean prebuild 静态检查不能替代签名制品检查。
- [ ] 登出数据清理仍需 M30-01/M30-02 闭环。当前风险是本地消息、草稿、文件索引/缓存等可能在登出后残留；`allowBackup=false` 只阻止系统迁移，不等于登出擦除。
- [ ] Share Extension 自带的 PrivacyInfo 与 app-group/keychain 数据路径需纳入最终 Apple 审计；依赖生成的 required-reason 值不能替代发布负责人的归档核验。

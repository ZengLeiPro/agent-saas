# M30-02 生物识别本地应用锁验收缺口

## 已由代码/自动化覆盖

- 功能默认关闭，仅在用户于设置中显式开启后生效。
- 开启前检查硬件与系统录入状态，验证当前服务端 session，并完成一次本地身份验证。
- 本地仅保存带 user/tenant/generation scope 的启用策略与 30 秒后台阈值；不保存生物模板。
- 冷启动锁定；后台达到 30 秒后锁定；短暂系统 prompt 不触发循环锁；prompt single-flight。
- 取消、失败、lockout 不自动重试；系统设备凭据和重新登录均可 fallback。
- 登出、token 失效、账号/tenant/generation 切换清除全部本地锁策略和解锁态。
- 离线本地解锁仅进入壳层：HTTP 敏感传输、token 滑动刷新、WebSocket 发送和旧连接均被阻断；恢复完整访问仍需 `/api/auth/me` 验证原 identity。
- SecureStore token 不使用生物识别作为读取旁路；Face ID 只解锁 UI。

## 发布前外部真机缺口

- [ ] iOS Face ID / Touch ID 真机：支持、未录入、成功、取消、连续失败、系统 lockout、设备密码 fallback。
- [ ] Android BiometricPrompt 真机：指纹/人脸与设备凭据 fallback，覆盖目标最低系统版本和 OEM 矩阵。
- [ ] 双平台验证冷启动、真实锁屏、后台 29 秒/30 秒边界，以及相机、图库、文件选择器、系统权限提示返回时无重复 prompt。
- [ ] 飞行模式下解锁仅可查看本地壳层，发送/上传/刷新/旧 WebSocket 均不可恢复；联网后过期 token 必须回到登录页。
- [ ] 对最终签名 IPA/AAB 扫描 Info.plist/merged manifest：iOS 文案准确，Android 仅含 `USE_BIOMETRIC`（兼容库可能含 `USE_FINGERPRINT`）且无新增危险权限。

自动化 clean prebuild 与静态扫描不能替代以上真机及最终签名制品验收。

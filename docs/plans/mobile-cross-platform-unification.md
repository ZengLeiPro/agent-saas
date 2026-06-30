# Mobile 跨平台统一化实施方案

> **状态**: 待实施
> **创建时间**: 2026-04-11
> **最后更新**: 2026-04-11

---

## 一、结论先行

`mobile/` 后续采用 **cross-platform-first** 策略：

- **默认目标**：iOS / Android 一套共享业务界面和交互逻辑
- **iOS 26 策略**：只做最新 SDK 兼容和系统壳层不坏，**不再主动追求 Liquid Glass / SwiftUI 特化视觉**
- **维护原则**：允许少量系统级薄差异，禁止业务层厚分叉
- **执行优先级**：先修 Android parity，再回收 iOS 26 视觉债，最后统一平台交互入口

一句话定义：

> `mobile` 不是 iOS app 的 Android 移植版，而是一个以单人维护可持续为前提的跨平台 React Native app。

---

## 二、当前问题清单

### 2.1 最高优先级问题：Android parity 已被破坏

以下三个核心表单当前是 iOS 真实现、Android 占位：

- `mobile/src/components/cron/CronJobForm.ios.tsx`（586 行）
- `mobile/src/components/user/UserForm.ios.tsx`（225 行）
- `mobile/src/components/user/ChangePasswordForm.ios.tsx`（91 行）
- `mobile/src/components/cron/CronJobForm.android.tsx`
- `mobile/src/components/user/UserForm.android.tsx`
- `mobile/src/components/user/ChangePasswordForm.android.tsx`

直接后果：

- Android 无法创建/编辑定时任务
- Android 无法创建/编辑用户
- Android 无法修改密码
- 后续每次迭代会继续强化“iOS 有、Android 没有”的路径依赖

### 2.2 第二优先级问题：iOS 26 视觉特化进入内容层

当前自定义 glass / blur 已进入业务内容层，而非停留在系统壳层：

- 会话标题胶囊：`mobile/app/chat/[sessionId].tsx`
- Token 浮层：`mobile/src/components/chat/TokenDetail.ios.tsx`
- 选择模式底部 pill：`mobile/app/(tabs)/chat/index.tsx`
- 选择模式底部 pill：`mobile/app/(tabs)/chat/group/[groupKey].tsx`
- 选择模式底部 pill：`mobile/app/(tabs)/files/index.tsx`
- 选择模式底部 pill：`mobile/app/(tabs)/files/browse.tsx`

这类代码和 Apple 官方 guidance 冲突，也会显著放大维护成本。

### 2.3 第三优先级问题：共享业务页直接依赖 iOS-only API

当前共享页面内存在多处直接调用：

- `Alert.prompt(...)`
- `ActionSheetIOS.showActionSheetWithOptions(...)`

风险：

- Android 真实行为不一致
- 业务页直接和平台 API 耦合
- 后续统一交互时需要逐页拆解

### 2.4 额外问题：抽象尝试存在，但没有真正收口

仓库里已有：

- `mobile/src/lib/glass.ts`
- `mobile/src/components/GlassBackground.tsx`

但业务页仍大量各自判断 `isGlassEffectAPIAvailable()` 并直接渲染 `GlassView`，说明当前不是“集中治理”，而是“页面散点特效”。

### 2.5 自动化兜底薄弱

当前 `mobile/` 侧未看到有效的测试或 e2e 验证体系。类型检查可通过，但不能覆盖：

- Android 运行时交互
- iOS / Android 菜单与弹窗差异
- 页面级视觉回归
- 业务主流程完整性

---

## 三、目标架构

### 3.1 总体原则

后续 `mobile` 代码按三层划分：

1. **共享业务层**
   - 表单、列表、详情、管理页主体、浮层、选择模式操作条
   - 默认一套组件和状态逻辑

2. **平台适配层**
   - 键盘、安全区、分享、菜单、字体、原生权限、日期选择器等系统级差异
   - 必须通过轻封装或极小范围 `Platform.select` 处理

3. **系统壳层**
   - Tab、Stack header、sheet、原生 menu 等
   - 允许适度跟随系统，但不允许把平台视觉特化扩散进业务内容层

### 3.2 明确允许的差异

允许保留或继续使用的差异：

- `KeyboardAvoidingView` 行为差异
- `NativeTabs` / 图标 fallback
- 等宽字体 `Menlo` / `monospace`
- `MenuView` 这种已有 Android 支持的跨平台原生菜单
- 安全区 / 手势 / 状态栏 / 分享面板等系统能力差异

### 3.3 明确禁止的差异

禁止继续扩张的模式：

- 新的业务层 `.ios.tsx` / `.android.tsx` 双实现
- 新的 `@expo/ui/swift-ui` 表单或页面主体
- 新的内容层 `GlassView` / Blur / Liquid Glass 特化
- 共享业务页直接写 `Alert.prompt` / `ActionSheetIOS`
- “iOS 有完整功能，Android 先占位以后再说”

---

## 四、范围与决策

### 4.1 本方案的明确决策

本方案按以下假设执行：

- **保留 mobile 中的管理能力**，而不是把它们整体赶回 Web
- **优先做功能对称**，不是先做视觉打磨
- **不追求原生感最大化**，而追求单人维护下的稳定、统一、低分叉

### 4.2 非目标

以下内容不属于本轮重点：

- 不做整套视觉系统重设计
- 不做 chat/file 等核心页面的大规模信息架构重写
- 不引入大量新依赖来模拟 iOS 26 特效
- 不为了“看起来更原生”而接受双端业务层分叉

---

## 五、分阶段实施

## Phase 0：冻结债务扩散

### 目标

先阻止技术债继续增长，再开始重构。

### 任务

1. 在 `CLAUDE.md` 增加 `mobile` 跨平台约束
2. 明确宣布 `mobile/` 后续采用 cross-platform-first
3. 停止新增：
   - `@expo/ui/swift-ui`
   - `expo-glass-effect` 的内容层用法
   - 业务层 `.ios/.android` 分叉
   - 共享业务页直接调用 iOS-only API
4. 在实施期间，所有新需求默认先走共享实现

### 完成标准

- 仓库规则已更新
- 未来 PR / 提交不再新增上述模式

---

## Phase 1：修复 Android parity

### 目标

让 Android 和 iOS 在管理类核心功能上回到同一水平。

### 任务

#### 5.1 表单实现合并

把以下组件改为单文件共享实现：

- `mobile/src/components/cron/CronJobForm.tsx`
- `mobile/src/components/user/UserForm.tsx`
- `mobile/src/components/user/ChangePasswordForm.tsx`

删除平台文件：

- `CronJobForm.ios.tsx`
- `CronJobForm.android.tsx`
- `UserForm.ios.tsx`
- `UserForm.android.tsx`
- `ChangePasswordForm.ios.tsx`
- `ChangePasswordForm.android.tsx`

#### 5.2 表单 UI 方案

共享表单建议基于 React Native 原生组件和现有 theme 搭建，不再依赖 SwiftUI bridge。

建议抽出一组共享表单基础组件，放在：

- `mobile/src/components/form/`

建议包含：

- `FormScrollView`
- `FormSection`
- `FormTextField`
- `FormSwitchRow`
- `FormPickerRow`
- `FormErrorBanner`
- `FormSubmitToolbar`（如后续需要）

#### 5.3 控件选型

- 普通输入：`TextInput`
- 开关：`Switch`
- 二选一 / 多选一：优先复用现有 `@react-native-segmented-control/segmented-control` 或主题化 pills
- 菜单选择：优先复用 `@react-native-menu/menu` 或页面内统一 modal picker
- 日期时间：引入成熟跨平台方案，优先 `@react-native-community/datetimepicker`

说明：

- 可以接受新增 **一个** 稳定、成熟、跨平台的日期选择依赖
- 不建议为了少一个依赖，重新引入平台分叉

#### 5.4 表单行为保持一致

共享实现需要保留现有关键行为：

- Cron 服务端校验
- `submit()` imperative ref
- dirty state 判断
- 创建 / 编辑模式切换
- readonly / view mode
- 删除、启用、立即执行等关联操作

### 文件级影响

直接受影响页面：

- `mobile/app/cron-form.tsx`
- `mobile/app/user-form.tsx`
- `mobile/app/change-password.tsx`

### 完成标准

- Android 可完整使用以上三个表单
- iOS / Android 使用同一业务表单代码
- `@expo/ui` 不再是业务核心依赖

### 风险

- 日期时间选择器在两端 UI 不完全一致
- 现有 SwiftUI 表单的一些只读展示逻辑需要重建

### 风险应对

- 只要求功能与信息结构一致，不要求像素级一致
- 先保留视觉朴素实现，后续再迭代样式

---

## Phase 2：回收内容层 iOS 26 视觉债

### 目标

把自定义 Liquid Glass 从内容层移除，恢复统一的共享视觉基元。

### 任务

1. 合并 `mobile/src/components/chat/TokenDetail.ios.tsx` 到 `mobile/src/components/chat/TokenDetail.tsx`
2. 删除会话标题玻璃胶囊，改为普通触发器容器：
   - `mobile/app/chat/[sessionId].tsx`
3. 删除选择模式底部 glass pills，统一为实色按钮 / 卡片：
   - `mobile/app/(tabs)/chat/index.tsx`
   - `mobile/app/(tabs)/chat/group/[groupKey].tsx`
   - `mobile/app/(tabs)/files/index.tsx`
   - `mobile/app/(tabs)/files/browse.tsx`
4. 删除无效或未收口抽象：
   - `mobile/src/lib/glass.ts`
   - `mobile/src/components/GlassBackground.tsx`
5. 评估并删除未使用的 blur header 组件：
   - `mobile/src/components/AppHeader.tsx`

### 视觉替代原则

- 内容层统一使用 `colors.card` / `colors.secondary` / `colors.border`
- 强调依赖颜色、边框、阴影和 spacing，而不是玻璃材质
- 优先使用微信式“稳定、轻微层次、无平台戏剧化特效”的视觉路线

### 完成标准

- 业务内容层不再依赖 `GlassView`
- `mobile/` 不再主动渲染 Liquid Glass 特效
- iOS / Android 内容区的视觉结构保持一致

---

## Phase 3：统一平台交互入口

### 目标

把散落在业务页里的 iOS-only 交互 API 收回到共享抽象层。

### 任务

#### 5.6 抽象文本输入提示

新增统一 prompt 能力，例如：

- `mobile/src/lib/prompt.ts`

建议 API：

```ts
showTextPrompt({
  title,
  message,
  defaultValue,
  placeholder,
  onConfirm,
});
```

实现建议：

- iOS 可继续调用系统 prompt
- Android 使用受控 `Modal` + `TextInput`
- 业务页只允许使用 `showTextPrompt`，不再直接写 `Alert.prompt`

#### 5.7 抽象动作菜单

新增统一 action menu 能力，例如：

- `mobile/src/lib/actionMenu.ts`

建议 API：

```ts
showActionMenu({
  title,
  actions,
  cancelText,
});
```

实现建议：

- iOS 可走 `ActionSheetIOS`
- Android 统一走 `Alert` 或底部 action sheet modal
- `ChatInput.tsx` 与 `MessageItem.tsx` 等共享组件通过统一入口调用

#### 5.8 替换现有直接调用

优先替换以下页面中的直接 iOS-only 调用：

- `mobile/app/chat/[sessionId].tsx`
- `mobile/app/(tabs)/chat/index.tsx`
- `mobile/app/(tabs)/chat/group/[groupKey].tsx`
- `mobile/app/(tabs)/settings/index.tsx`
- `mobile/src/components/chat/ChatInput.tsx`
- `mobile/src/components/chat/MessageItem.tsx`

### 完成标准

- 共享业务页不再直接使用 `Alert.prompt`
- `ActionSheetIOS` 只留在平台适配层或完全移除
- Android / iOS 的重命名、创建分组、附件选择等交互可稳定对齐

---

## Phase 4：统一导航壳层并清理依赖

### 目标

让导航样式回到“统一、稳定、低维护”状态，并移除无意义依赖。

### 任务

#### 5.9 统一 stack header 策略

当前多处 `_layout.tsx` 使用：

- iOS `headerTransparent: true`
- Android `headerStyle: { backgroundColor: colors.card }`

建议统一为：

- 默认非透明 header
- 默认 `headerStyle.backgroundColor = colors.card`
- 默认 `headerShadowVisible = false`

涉及：

- `mobile/app/(tabs)/chat/_layout.tsx`
- `mobile/app/chat/_layout.tsx`
- `mobile/app/(tabs)/cron/_layout.tsx`
- `mobile/app/(tabs)/settings/_layout.tsx`
- `mobile/app/settings/_layout.tsx`
- `mobile/app/settings/agent-profile/_layout.tsx`

说明：

- 这不是说“永远不能透明”，而是透明 header 必须变成例外，而不是默认

#### 5.10 合并 AuditFilterBar

优先尝试将：

- `mobile/src/components/audit/AuditFilterBar.ios.tsx`
- `mobile/src/components/audit/AuditFilterBar.tsx`

收敛为一份共享实现。

建议优先级：

1. 先尝试保留 `@react-native-menu/menu` 跨平台使用
2. 若 Android 菜单体验不稳定，再退回统一 pills / modal 方案

#### 5.11 依赖与 patch 清理

在完成以上收敛后，清理：

- `@expo/ui`
- `expo-glass-effect`
- `expo-blur`
- `patches/@expo__ui.patch`

是否清理 `patches/@react-native-menu__menu.patch`，取决于最终是否仍保留该库及其 iOS patch 诉求。

### 完成标准

- 导航 header 默认统一
- `mobile` 依赖减少
- 平台 patch 数量下降

---

## Phase 5：验证与发布门槛

### 目标

在没有完整自动化测试的前提下，建立最低限度的发布纪律。

### 必做检查

#### 5.12 静态检查

每次涉及 `mobile/` 的重构至少运行：

```bash
pnpm -C mobile exec tsc --noEmit
```

#### 5.13 双端 smoke checklist

每次涉及 `mobile` 交互或 UI 变更时，至少人工验证：

1. 登录
2. 会话列表进入与选择模式
3. 会话重命名
4. 分组创建 / 加入 / 移出
5. 发消息
6. 附件选择
7. 文件列表浏览与批量操作
8. 定时任务创建 / 编辑 / 删除 / 启用
9. 用户创建 / 编辑
10. 修改密码
11. 设置页服务器地址 / 内网地址编辑

要求：

- 不能只验证 iOS
- 若当次改动涉及共享交互逻辑，必须同时验证 Android

#### 5.14 发版前检查

发 TestFlight 或 Android 包之前，确认：

- 没有新增业务层 `.ios/.android` 分叉
- 没有新增内容层 GlassView
- 没有新增共享业务页直接调用 iOS-only API

---

## 六、实施顺序建议

建议拆成 4 个连续 PR / 提交批次，避免一次性改太多：

### 批次 1

- 文档与规则冻结
- 引入共享表单基元
- 搭好 prompt / action menu 抽象骨架

### 批次 2

- 重写 3 个管理表单
- 删除表单 `.ios/.android` 分叉

### 批次 3

- 删除内容层 glass
- 合并 TokenDetail
- 清理 glass helper

### 批次 4

- 替换散落的 `Alert.prompt` / `ActionSheetIOS`
- 收敛 AuditFilterBar
- 统一 header
- 清理依赖和 patch

---

## 七、最终验收标准

实施完成后，应满足以下条件：

1. `mobile/src/` 下不再存在业务层 `.ios.tsx` / `.android.tsx`
2. Android 不再有“暂不支持”的核心功能占位页
3. 共享业务页不再直接使用 `Alert.prompt`
4. 业务内容层不再主动使用 `GlassView`
5. `@expo/ui`、`expo-glass-effect`、`expo-blur` 已清理或不再参与核心流程
6. iOS / Android 在主要业务路径上保持功能等价
7. 后续新增 mobile 功能默认只写一份业务代码

---

## 八、成功标准

如果这个方案执行正确，你会得到以下结果：

- 新需求默认只改一套业务代码
- Android 不再是“事后补洞”
- iOS 不再为追逐新视觉而持续生长特化债务
- 每次移动端迭代的心智负担显著下降
- `mobile` 可以稳定朝“微信式务实统一界面”收敛

---

## 九、参考

- Apple `Adopting Liquid Glass`
- Apple HIG `Materials`
- Expo `expo-glass-effect` 文档
- Expo `@expo/ui/swift-ui` 文档
- `@react-native-menu/menu` README

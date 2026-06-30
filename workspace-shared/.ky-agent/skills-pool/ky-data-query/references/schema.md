# 实体 Schema 参考（CLI list 响应视角）

本文件描述每个实体 `azeroth <entity> list` 返回的 NDJSON 每行 JSON 结构。它是**静态速查缓存**，可能落后于最新 CLI；实时第一信源永远是 `azeroth describe <entity> --action response` / `--action query`。字段类型以 ky-azeroth/packages/shared/src/schemas/\*.ts 的 `xxxResponseSchema` 为准（优先级高于 prisma schema，因为 response 层可能过滤字段）。

## 通用约定

- **审计字段**（几乎所有业务实体都有，下文不重复列出）：
    - `id`: string (uuid)
    - `createdAt` / `updatedAt`: string (ISO 时间)
    - `createdBy` / `updatedBy`: string | null
    - `deletedAt`: string | null — 软删除标记，**查询时 `WHERE "deletedAt" IS NULL`**
    - `version`: number — 乐观锁
- **Decimal 字段**：后端是 Prisma Decimal，序列化后是 number 或 string，统一 `CAST(x AS DECIMAL(18,2))` 处理。
- **ID 命名**：
    - `customerId` / `opportunityId` / `saleOrderId` / `contactId` 是 UUID string
    - `chargerId` 在 customers/opportunities/sale_orders/payments/keep_records/visit_records 里是 **`employees.id`（UUID）**，04-06 后已归一化（旧文档说"钉钉 userId"已过时）。同规则适用 `projects.ownerId`、`project_tickets.assigneeId/dispatcherId`、`effort_records.ownerId`。
- **list vs get 差异**：list 通常不返回深度嵌套子数组；get `/<id>` 会多返回 `contacts` / `products` / `departments` 等子数组。

---

## CRM 模块

### customers（客户）

CLI：`azeroth customers list --all --output $SESS/customers.ndjson`

每行 JSON：

- `id`: string (uuid)
- `serialNumber`: string — 客户编号（如 `CUS00001`）
- `customerName`: string — 客户名称
- `shortName`: string | null — 简称
- `industry`: string | null — 行业（enum: 制造业/互联网/零售/...）
- `customerLevel`: string | null — 客户质量（A/B/C/D）
- `customerSource`: string | null — 来源
- `customerRelationship`: string | null — 客户关系
- `customerTags`: string[] | null — 客户标签
- `country` / `province` / `city` / `district`: string | null — 地区
- `address`: string | null
- `phone`: string | null
- `remark`: string | null
- `aiInfoSummary`: string | null — AI 信息汇总
- `organizationId` / `uncId` / `headcountRange`: string | null
- `chargerId`: string | null — 负责人 `employees.id`（UUID，04-06 已归一化）
- `chargerName`: string | null — 负责人姓名（已转换）
- `collaboratorName`: string | null — 协作人姓名（逗号分隔）
- `collaboratorIds`: string[] | null
- `contactStatus`: string | null — 接触状态
- `dealStatus`: string | null — 赢单状态（未赢单/已赢单/多次赢单）
- `lastKeepRecordTime`: string | null — 最近跟进时间（ISO）
- `lastKeepRecordContent`: string | null
- `paidAmountLast365Days`: number | null — Decimal
- `accountsReceivable`: number | null — Decimal
- `status`: string
- `contacts`: { id, contactName, mobile, phone, position }[] | undefined — get 才返回完整列表

⚠️ list 不返回 opportunities / orders / payments 等子数组，做客户全貌需额外 JOIN。

JOIN key：`"customerId"`（被 contacts / opportunities / sale_orders / payments / invoices / keep_records / visit_records 引用）

### contacts（联系人）

CLI：`azeroth contacts list --all --output $SESS/contacts.ndjson`

- `id`: string
- `contactName`: string
- `customerId`: string — 所属客户 id
- `sex`: string | null — 性别（male/female）
- `mobile` / `phone` / `email` / `wechat`: string | null
- `position` / `department`: string | null — 职务 / 部门
- `decisionMaker`: string | null — yes/no
- `remark`: string | null
- `status`: string
- `customer`: { id, customerName, shortName } | undefined — include

### opportunities（商机）

CLI：`azeroth opportunities list --all --output $SESS/opportunities.ndjson`

- `id`: string
- `serialNumber`: string — 商机编号
- `opportunityName`: string
- `customerId`: string
- `customerName`: string | null — include 扁平化
- `contactId`: string | null
- `contactName`: string | null
- `opportunityStage`: string | null — 赢单/输单流失/解决方案/发现需求/商务谈判/合同签约（"赢单"和"输单流失"为终态）
- `opportunityAmount`: number | null — Decimal
- `winRate`: number | null — Decimal（百分比，如 60 = 60%）
- `expectedDealDate`: string | null — ISO 日期
- `realDealDate`: string | null
- `chargerId`: string | null — `employees.id`（UUID，04-06 已归一化）
- `chargerName`: string | null
- `loseReason`: string | null
- `remark`: string | null
- `status`: string
- `customer`: { id, customerName, shortName } | undefined
- `contact`: { id, contactName } | undefined
- `products`: { id, productName, productNumber, quantity, unitPrice, subtotalAmount, ... }[] | undefined — 商机产品明细（list 返回可能为空；get 完整）

活跃商机过滤：`WHERE "opportunityStage" NOT IN ('赢单','输单流失') AND "deletedAt" IS NULL`。

### keep-records（跟进记录）

CLI：`azeroth keep-records list --all --output $SESS/keep_records.ndjson`

- `id`: string
- `customerId`: string
- `contactId`: string | null
- `keepRecordType`: string | null — 电话/拜访/微信/邮件/见面/其他（真实值以数据为准）
- `keepRecordTime`: string | null — ISO 时间
- `keepRecordContent`: string | null
- `keepRecordStatus`: string | null
- `signLocation` / `signAddress`: string | null
- `attachments`: { id, url, ... }[] | null
- `chargerId`: string | null — `employees.id`（UUID，04-06 已归一化）
- `chargerName`: string | null — 跟进人
- `customer`: { id, customerName, shortName } | undefined
- `contact`: { id, contactName } | undefined

按客户最近跟进：`SELECT "customerId", MAX("keepRecordTime"::TIMESTAMP) FROM keep_records WHERE "deletedAt" IS NULL GROUP BY 1`。

### sale-orders（合同订单）

CLI：`azeroth sale-orders list --all --output $SESS/sale_orders.ndjson`

- `id`: string
- `serialNumber`: string — 合同编号
- `orderTitle`: string | null
- `customerId`: string
- `customerName`: string | null
- `opportunityId`: string | null
- `opportunityName`: string | null
- `orderAmount`: number | null — 合同金额 Decimal
- `productAmount`: number | null — 产品合计 Decimal
- `totalReceivables`: number | null — 应收总额（**可能不完整，精确值从 payments 聚合**）
- `totalReceived`: number | null — 已收总额
- `totalUncollected`: number | null — 待收总额
- `orderStatus`: string | null
- `businessDate` / `orderBeginDate` / `orderEndDate`: string | null — ISO 日期
- `chargerId`: string | null
- `chargerName`: string | null
- `remark`: string | null
- `status`: string
- `flowStatus`: string | null — 审批流状态
- `customer`: { id, customerName, shortName } | undefined
- `opportunity`: { id, opportunityName, serialNumber } | undefined
- `products`: { id, productName, quantity, unitPrice, subtotalAmount }[] | undefined

**精确回款额**务必从 payments 表聚合：`SELECT "saleOrderId", SUM(CAST("paymentAmount" AS DECIMAL(18,2))) FROM payments WHERE "deletedAt" IS NULL GROUP BY 1`。

### payments（回款）

CLI：`azeroth payments list --all --output $SESS/payments.ndjson`

- `id`: string
- `serialNumber`: string
- `saleOrderId`: string
- `orderSerialNumber`: string | null — include 扁平化
- `customerId`: string
- `customerName`: string | null
- `paymentAmount`: number — Decimal，**必须非 null**
- `paymentType`: string | null — 银行转账/现金/支票/...
- `businessDate`: string | null
- `payer` / `bankName` / `tradeSerialNumber`: string | null
- `chargerId` / `chargerName`: string | null
- `status`: string
- `flowStatus`: string | null
- `customer`: { id, customerName, shortName } | undefined
- `saleOrder`: { id, orderTitle, serialNumber } | undefined

### invoices（发票）

CLI：`azeroth invoices list --all --output $SESS/invoices.ndjson`

- `id`: string
- `serialNumber`: string
- `saleOrderId`: string
- `orderSerialNumber`: string | null
- `customerId`: string
- `customerName`: string | null
- `invoiceAmount`: number — Decimal，**必须非 null**
- `invoiceType` / `invoiceNumber` / `invoiceDate`: string | null
- `title` / `taxIdentifyNum`: string | null
- `invoiceStatus`: string | null — 待开具/已开具/已红冲/...
- `itemType` / `bankName` / `bankAccount` / `registeredAddress` / `registeredPhone`: string | null
- `remark`: string | null
- `status`: string
- `flowStatus`: string | null

### visit-records（拜访签到）

CLI：`azeroth visit-records list --all --output $SESS/visit_records.ndjson`

- `id`: string
- `customerId`: string
- `contactId`: string | null
- `visitType`: string | null — 拜访/电话回访/...
- `content`: string | null — 拜访内容
- `signInTime` / `signOutTime`: string | null — ISO 时间
- `signAddress`: string | null — 签到地址
- `duration`: number | null — 分钟
- `visitStatus`: string | null
- `attachments`: { ... }[] | null
- `chargerId` / `chargerName`: string | null
- `flowStatus`: string | null
- `customer` / `contact`: 关联对象

### crm-products（产品目录）

CLI：`azeroth crm-products list --all --output $SESS/crm_products.ndjson`

- `id`: string
- `productName`: string
- `productNumber`: string | null
- `productTypes`: string | null
- `productUnit`: string | null — 件/套/月/...
- `standardPrice`: number | null — Decimal
- `productStatus`: string | null
- `remark`: string | null
- `status`: string

### crm-work-dailies（CRM 工作日报）

CLI：`azeroth crm-work-dailies list --all --output $SESS/crm_work_dailies.ndjson`

- `id`: string
- `reportDate`: string | null — ISO 日期
- `reportType`: string | null — 日报/周报
- `submitStatus`: string | null
- `senderId`: string | null
- `senderName`: string | null
- `keyCustomerSummary` / `tomorrowVisitPlan` / `otherPlanArrangements` / `coordinationItems`: string | null
- `callsMadeCount` / `callsConnectedCount` / `visitCustomerCount` / `newCustomerCount`: number | null
- `attachments`: { ... }[] | null
- `remark`: string | null
- `status`: string

---

## 组织架构模块

### employees（员工）

CLI：`azeroth employees list --all --output $SESS/employees.ndjson`

- `id`: string (uuid)
- `serialNumber`: string — 工号
- `name`: string
- `phone` / `email`: string | null
- `gender`: string | null
- `position`: string | null
- `status`: string — active / inactive
- `entryDate`: string | null — ISO
- `avatar`: string | null
- `dingtalkUserId`: string | null — 钉钉 userId（**04-06 后已不再用于 JOIN chargerId**，仅作展示/调试）
- `dingtalkUnionId`: string | null
- `jobNumber`: string | null
- `workPlace`: string | null
- `isAdmin` / `isBoss` / `isLeader` / `dingtalkActive`: boolean
- `dingtalkExtension`: object | null
- `lastSyncAt`: string | null
- `departments`: { id, departmentId, departmentName, isPrimary }[] | undefined
- `primaryDepartment`: { id, departmentId, departmentName, isPrimary } | null
- `departmentName`: string | null — 便捷扁平字段（= primaryDepartment.departmentName）

### departments（部门）

CLI：`azeroth departments list --all --output $SESS/departments.ndjson`

- `id`: string (uuid)
- `name`: string
- `parentId`: string | null — 父部门 id（自关联树）
- `sortOrder`: number
- `status`: string
- `managerId`: string | null — 员工 id
- `dingtalkDeptId`: number | null
- `dingtalkParentId`: number | null
- `createDeptGroup` / `autoAddUser`: boolean
- `lastSyncAt`: string | null
- `parent`: { id, name, parentId } | null
- `manager`: { id, name } | null
- `employeeCount` / `childrenCount`: number

⚠️ 部门 schema 无 `deletedAt`（见 response 字段），但底层 prisma 有——`list` 默认过滤了软删除，所以这里不用再过滤。

### users（系统用户）

CLI：`azeroth users list --all --output $SESS/users.ndjson`

- `id`: string (uuid)
- `username`: string
- `phone` / `email` / `avatar`: string | null
- `employeeId`: string | null
- `roles`: { id, code, name, permissions[], status }[]
- `status`: string
- `lastLoginAt` / `lastLoginIp`: string | null
- `employee`: { id, name } | null

### roles（角色）

CLI：`azeroth roles list --all --output $SESS/roles.ndjson`

- `id`: string (uuid)
- `code`: string — 如 `ADMIN` / `SALES`
- `name`: string
- `description`: string | null
- `permissions`: { module, menu, view, create, edit, delete, export, approve }[]
- `status`: `active` | `disabled`
- `userCount`: number

---

## 项目 & 工时模块

### projects（项目）

CLI：`azeroth projects list --all --output $SESS/projects.ndjson`

- `id`: string
- `name`: string
- `description`: string | null
- `status`: string
- `logicalStatus`: string | null
- `category`: string | null
- `customerId`: string | null
- `customerName`: string | null
- `startDate` / `endDate`: string | null
- `ownerId`: string | null — **employees.id（UUID，不是钉钉 userId）**
- `ownerName`: string | null
- `members`: { id, projectId, employeeId, userName, role, isActive }[] | undefined
- `saleOrders`: { id, saleOrderId, orderTitle, orderAmount }[] | undefined

### project-tickets（项目工单）

CLI：`azeroth project-tickets list --all --output $SESS/project_tickets.ndjson`

- `id`: string
- `ticketNo`: string — 工单编号
- `projectId`: string
- `title`: string
- `description`: string
- `ticketType`: string — BUG/FEATURE/TASK/...
- `priority`: string — LOW/MEDIUM/HIGH/URGENT
- `status`: string — PENDING/IN_PROGRESS/COMPLETED/CLOSED/CANCELLED
- `source`: string | null
- `dispatcherId`: string — 派单人 employees.id
- `assigneeId`: string — 接单人 employees.id
- `dueDate`: string | null
- `startedAt` / `completedAt` / `closedAt` / `cancelledAt`: string | null
- `completionNote` / `closeNote` / `cancelReason`: string | null
- `attachments`: { ... }[] | null
- `isOverdue`: boolean
- `project`: { id, name, customerName } | undefined
- `dispatcher` / `assignee`: { id, name } | undefined

### effort-records（工时记录）

CLI：`azeroth effort-records list --all --output $SESS/effort_records.ndjson`

- `id`: string
- `projectId`: string
- `projectName`: string | null
- `actualTime`: number — Decimal，小时
- `description`: string | null
- `workType`: string | null
- `workDate`: string | null — YYYY-MM-DD
- `recordType`: string — ACTUAL / PLANNED 等
- `ownerId`: string | null — 员工 `employees.id`（工时所属人）
- `ownerName`: string | null
- `startDate` / `endDate`: string | null
- `project`: { id, name, customerName } | undefined

---

## 审批 & 薪资

### 审批"实例"未通过 CLI 暴露

业务系统里的「审批实例」（谁发起了哪笔订单审批、当前在哪个节点、谁审批通过）目前**没有**对应的 CLI 命令。CLI 只有 `approval-flows`（审批流模板，描述"销售订单激活"等流程的节点结构），且属于 SKILL.md 的"不要查询的实体"清单。

如果用户问"XX 单审批进度""谁审了哪些单"等，告知 CLI 暂不支持，让用户去业务系统页面查。**不要硬凑**。

### payroll（薪资记录）

CLI：`azeroth payroll list --all --output $SESS/payroll.ndjson`

⚠️ **敏感数据**，输出时做聚合或脱敏，不要贴原始行。

- `id`: string
- `payrollPeriodId`: string
- `periodKey`: string — YYYY-MM
- `employeeId` / `departmentId`: string | null
- `employeeNameSnapshot` / `departmentNameSnapshot` / `positionSnapshot`: string | null
- `entryDateSnapshot`: string | null
- `bankNameSnapshot` / `bankCardNoSnapshot`: string | null
- `actualAttendanceDays` / `absenceDays`: number | null
- `grossBaseSalary` / `grossPerformance` / `grossCommission` / `grossOther` / `grossBonusYearEnd`: number | null
- `grossTotal`: number | null — Decimal，应发合计
- `absenceDeductionAmount` / `lateDeductionAmount` / `adminDeductionAmount`: number | null
- `socialSecurityPersonalAmount` / `housingFundPersonalAmount`: number | null
- `deductionOtherTotal` / `deductionTotal`: number | null
- `socialSecurityCompanyAmount` / `housingFundCompanyAmount` / `companyBurdenTotal`: number | null
- `netSalary`: number | null — Decimal，实发工资
- `totalLaborCost`: number | null — Decimal，人工成本
- `importBatchId`: string | null
- `payrollPeriod` / `employee` / `department`: 关联对象

---

## 钉钉/系统只读模块

以下 4 张表**没有 deletedAt 字段**，SQL 不要带软删除过滤。

### dingtalk-logs（钉钉日报/周报）

CLI：`azeroth dingtalk-logs list --all --output $SESS/dingtalk_logs.ndjson`

- `reportId`: string — 主键
- `templateName`: string | null — 日报/周报/月报
- `creatorId`: string | null — 一般是 `employees.id`（UUID）；具体表不一致时以最新代码为准
- `creatorName`: string | null
- `deptName`: string | null
- `contents`: object | null — JSON 对象（字段名动态，需 `contents['xxx']` 访问）
- `createTime`: string | null — ISO
- `syncedAt`: string | null

### dingtalk-calendar-events（钉钉日程）

CLI：`azeroth dingtalk-calendar-events list --all --output $SESS/calendar_events.ndjson`

- `eventId`: string — 主键
- `title`: string | null
- `description`: string | null
- `startTime` / `endTime`: string | null
- `location`: string | null
- `creator`: string | null
- `attendees`: string[] | null
- `syncedAt`: string | null

### employee-leaves（离职记录）

CLI：`azeroth employee-leaves list --all --output $SESS/employee_leaves.ndjson`

- `id`: string
- `dingtalkUserId`: string — 钉钉 userId
- `name`: string
- `mobile`: string | null
- `leaveTime`: string | null
- `leaveReason`: string | null
- `syncedAt`: string | null

### login-logs（登录日志）

CLI：`azeroth login-logs list --all --output $SESS/login_logs.ndjson`

- `id`: string (uuid)
- `userId`: string (uuid)
- `username`: string
- `actionType`: `login` | `logout`
- `ip`: string
- `userAgent`: string | null
- `location`: string | null
- `status`: `success` | `failed`
- `failReason`: string | null
- `createdAt`: string — ISO 时间

---

## 快速查字段命令

```bash
# 实时查看 CLI 会返回什么字段：
azeroth describe customers --action response
azeroth describe opportunities --action response
azeroth describe sale-orders --action query   # 查询可用的 filter 参数
```

不确定时以 `describe` 的输出为准，response schema 会跟随后端升级。

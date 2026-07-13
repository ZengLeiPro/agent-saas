---
name: skill-demo
description: 操作开沿在线业务系统 Demo 沙盘。用户要求在 demo/演示系统/CRM/餐饮ERP/设备ERP 中新建、查询、修改客户、联系人、商机、合同、回款、发票、门店、产品、库存、采购、工单、报工、销售订单，或要求对 demo 数据做统计分析并给出可打开页面链接时，必须使用本技能。该技能通过线上 REST API 操作已部署系统，完成后返回客户可在浏览器打开核实的链接。
---

# Skill Demo 在线业务沙盘

用线上 API 操作三合一 Demo 系统，并把结果链接发给客户核实。这个 skill 用于销售演示和客户自助体验：客户和 Agent 对话提出业务动作，Agent 调 API 完成操作/分析，再给出对应系统页面链接。

## 系统范围

三套系统共用一个线上 FC 后端、一个 demo 数据库和一个 OSS 前端：

- API base：`https://fc.kaiyan.net/skill-demo/api/v1`
- Web base：`http://skill-demo.kaiyancn.com`
- `cywk/*`：餐饮 ERP
- `crm/*`：CRM
- `bom/*`：设备 ERP / 设备 BOM

前端会自动向 `/api/v1/auth/token` 获取 demo token，客户打开链接时不需要账号密码，也不需要 Agent 注入 localStorage。

## 工作流

1. 判断用户要操作哪个系统、哪个资源、什么动作。
2. 需要字段或路径时先读 `references/routes.md` 和 `references/api.md`。
3. 查询/分析走 `scripts/crud.mjs get ...`，必要时分页拉取后自行汇总。
4. 新增/修改/删除走 `scripts/crud.mjs` 调 API。
5. 操作后用 GET 复核结果，向用户说明新增记录 id、关键字段、统计结论或变更结果。
6. 用 `scripts/open-page.mjs <route>` 生成可打开链接，把链接给用户核实。

## 命令用法

设定 skill 目录变量，实际路径以当前运行环境中本 skill 所在目录为准：

```bash
SKILL_DIR="<skill-demo skill directory>"
```

登录/健康检查：

```bash
node "$SKILL_DIR/scripts/crud.mjs" login
node "$SKILL_DIR/scripts/crud.mjs" get health
```

常见查询：

```bash
node "$SKILL_DIR/scripts/crud.mjs" get "crm/customers?page=1&pageSize=20&keyword=能源"
node "$SKILL_DIR/scripts/crud.mjs" get "cywk/stores?page=1&pageSize=20"
node "$SKILL_DIR/scripts/crud.mjs" get "bom/stock"
```

新增/修改：

```bash
node "$SKILL_DIR/scripts/crud.mjs" post crm/customers --data '{"name":"演示客户","industry":"制造业","level":"A"}'
node "$SKILL_DIR/scripts/crud.mjs" patch crm/customers/<id> --data '{"level":"B"}'
node "$SKILL_DIR/scripts/crud.mjs" put cywk/stores/<id> --data '{"name":"泉州演示门店"}'
```

删除必须先得到用户明确确认，并追加 `--confirm-delete`：

```bash
node "$SKILL_DIR/scripts/crud.mjs" delete crm/customers/<id> --confirm-delete
```

生成客户可打开链接：

```bash
node "$SKILL_DIR/scripts/open-page.mjs" /crm/customers
node "$SKILL_DIR/scripts/open-page.mjs" /cywk/stores
node "$SKILL_DIR/scripts/open-page.mjs" /bom/sales/customers
```

脚本会输出 JSON，其中 `url` 是优先发给用户的深链接，`fallbackUrl` 是根入口兜底。`probe.status` 只用于排障；如果页面可打开，不要把技术状态码讲给客户。

## 页面路由

优先用 `references/routes.md` 的映射。常用页面：

- CRM 客户：`/crm/customers`
- CRM 联系人：`/crm/contacts`
- CRM 商机：`/crm/opportunities`
- CRM 合同：`/crm/contracts`
- CRM 回款：`/crm/payments`
- CRM 发票：`/crm/invoices`
- CRM 跟进：`/crm/follow-ups`
- CRM 拜访：`/crm/visits`
- 餐饮 ERP 门店：`/cywk/stores`
- 餐饮 ERP 产品：`/cywk/products`
- 餐饮 ERP 采购订单：`/cywk/purchase-orders`
- 餐饮 ERP 库存：`/cywk/inventory`
- 设备 ERP 库存：`/bom/inventory/stock`
- 设备 ERP 出入库：`/bom/inventory/in-out`
- 设备 ERP 工单：`/bom/production/work-orders`
- 设备 ERP 报工：`/bom/production/report`
- 设备 ERP 销售订单：`/bom/sales/so`

## 安全与演示边界

- 这是共享 demo 数据库，暂不做租户隔离。写入演示数据时，优先使用带时间或客户名的可识别名称，方便用户核实。
- 查询和统计可直接执行。
- 新增在用户明确表达要新增时可直接执行；执行后必须 GET 复核。
- 修改已有记录前，先 GET 定位目标，向用户说明将修改的 id 和关键字段；用户意图明确时再执行。
- 删除前必须列出目标 id 和关键字段并得到明确确认；脚本层也要求 `--confirm-delete`。
- 不要打印 accessToken 或 auth-state。`crud.mjs token` 默认拒绝输出。
- 不要使用 Playwright 弹窗口给客户看。Agent 在云端运行，正确做法是返回页面 URL。

## 分析回答要求

做数据分析时，不要只贴接口 JSON。应输出：

- 使用了哪些数据范围和过滤条件。
- 关键数量、金额、状态分布或异常点。
- 与用户问题直接相关的一句话结论。
- 可打开核实的页面链接。

## 同步与维护

- `references/api.md` 是当前操作字段和路径参考；如果接口报字段错误，先用 GET 看真实响应，再按源代码或 OpenAPI 更新该文件。
- `config.json` 可覆盖线上地址，但不要提交；默认使用 `config.example.json`。

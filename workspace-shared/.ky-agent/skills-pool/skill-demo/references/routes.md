# 资源 → 前端路由 / API 路径对照表

三套业务系统(cywk / crm / bom)共用同一个 FC 后端,按业务前缀分家。
表中的**前端路由**用于 `scripts/open-page.mjs`,**API 路径**用于 `scripts/crud.mjs`。

约定:
- 前端完整地址 = `${webBase}${前端路由}`(受登录保护,进入前需注入 token,见 SKILL.md)
- API 完整地址 = `${apiBase}${API 路径}`(`apiBase` 已含 `/api/v1`)
- **真实 API 路径与请求体字段以 `api.md`(OpenAPI 生成)为准**,与本表不一致时以 `api.md` 为准
- 标「只读」的页面一般只查询,不做增删改

---

## ① cywk 餐饮 ERP(前端 `/cywk/*`,API `/api/v1/cywk/*`)

| 中文名 | 触发关键词示例 | 前端路由 | API 路径 | 读写 |
|---|---|---|---|---|
| 门店档案 | 门店、店铺、分店 | `/cywk/stores` | `cywk/stores` | 增删改查 |
| 仓库档案 | 仓库、库房 | `/cywk/warehouses` | `cywk/warehouses` | 增删改查 |
| 产品类型 | 产品类型、品类、产品分类 | `/cywk/product-categories` | `cywk/product-categories` | 增删改查 |
| 产品信息 | 产品、商品、SKU、物料 | `/cywk/products` | `cywk/products` | 增删改查 |
| 供应厂商 | 供应商、供货商、厂商 | `/cywk/suppliers` | `cywk/suppliers` | 增删改查 |
| 采购订单 | 采购订单、采购单 | `/cywk/purchase-orders` | `cywk/purchase-orders` | 增删改查 |
| 采购入库 | 采购入库、入库单、到货 | `/cywk/purchase-inbound` | `cywk/purchase-inbound` | 增删改查 |
| 仓库出库 | 出库、出库单、领用 | `/cywk/warehouse-outbounds` | `cywk/warehouse-outbounds` | 增删改查 |
| 仓库汇总 | 库存、库存汇总、结存 | `/cywk/inventory` | `cywk/inventory` | 通常只读 |
| 门店要货 | 门店要货、要货单、补货 | `/cywk/store-order-requests` | `cywk/store-order-requests` | 增删改查 |
| 收银数据 | 收银、营业额、销售流水 | `/cywk/cashier-orders` | `cywk/cashier-orders` | 视后端 |
| 巡检标准 | 巡检标准、检查标准 | `/cywk/inspection-standards` | `cywk/inspection-standards` | 增删改查 |
| 巡检记录 | 巡检记录、检查记录 | `/cywk/inspection-records` | `cywk/inspection-records` | 增删改查 |
| 资产分类 | 资产分类、资产类别 | `/cywk/asset-categories` | `cywk/asset-categories` | 增删改查 |
| 固定资产 | 固定资产、设备、资产卡片 | `/cywk/fixed-assets` | `cywk/fixed-assets` | 增删改查 |
| 资产调拨 | 资产调拨、调拨单 | `/cywk/asset-transfers` | `cywk/asset-transfers` | 增删改查 |
| 资产报废 | 资产报废、报废单 | `/cywk/asset-disposals` | `cywk/asset-disposals` | 增删改查 |
| 工作台首页 | 首页、看板、Dashboard | `/cywk/` | `cywk/dashboard/overview` | 只读 |

## ② CRM(前端 `/crm/*`,API `/api/v1/crm/*`)

| 中文名 | 触发关键词示例 | 前端路由 | API 路径 | 读写 |
|---|---|---|---|---|
| 客户 | 客户、客户管理 | `/crm/customers` | `crm/customers` | 增删改查 |
| 联系人 | 联系人、对接人 | `/crm/contacts` | `crm/contacts` | 增删改查 |
| 商机 | 商机、销售机会、线索 | `/crm/opportunities` | `crm/opportunities` | 增删改查 |
| 合同订单 | 合同、订单 | `/crm/contracts` | `crm/contracts` | 增删改查 |
| 回款 | 回款、收款 | `/crm/payments` | `crm/payments` | 增删改查 |
| 开票 | 开票、发票 | `/crm/invoices` | `crm/invoices` | 增删改查 |
| 跟进记录 | 跟进、跟进记录 | `/crm/follow-ups` | `crm/follow-ups` | 增删改查 |
| 拜访签到 | 拜访、签到、外勤 | `/crm/visits` | `crm/visits` | 增删改查 |
| 产品 | CRM 产品、报价产品 | `/crm/products` | `crm/products` | 增删改查 |

## ③ BOM 设备 ERP(前端 `/bom/*`,API `/api/v1/bom/*`)

**注意 bom 前端路由用了二级分组**(生产/采购/销售/库存),API 是扁平的。

| 中文名 | 触发关键词示例 | 前端路由 | API 路径 | 读写 |
|---|---|---|---|---|
| 生产工单 | 生产工单、工单、MO | `/bom/production/work-orders` | `bom/work-orders` | 增删改查 |
| 报工 | 报工、工时、生产报工 | `/bom/production/report` | `bom/work-orders`(报工作为工单动作) | 增删改查 |
| 采购入库 | 采购入库、进货、到货 | `/bom/procurement/po` | `bom/purchase-orders` | 增删改查 |
| 供应商 | BOM 供应商 | `/bom/procurement/suppliers` | `bom/suppliers` | 增删改查 |
| 销售订单 | 销售订单、SO | `/bom/sales/so` | `bom/sales-orders` | 增删改查 |
| 客户管理 | BOM 客户、设备客户 | `/bom/sales/customers` | `bom/customers` | 增删改查 |
| 库存总览 | 库存、库存总览 | `/bom/inventory/stock` | `bom/stock` | 只读 |
| 出入库流水 | 出入库、库存移动 | `/bom/inventory/in-out` | `bom/moves` | 增删改查 |
| 销售出库 | 销售出库、发货、Shipment | `/bom/inventory/shipment` | `bom/shipments` | 增删改查 |

## ⑨ 全局(非业务)

| 路径 | 用途 |
|---|---|
| `POST /api/v1/auth/token` | DEMO 免密签发永不过期 token(crud.mjs 内部用) |
| `GET /api/v1/auth/me` | 获取当前 demo 用户 |
| `GET /api/v1/health` | 健康检查 |
| `GET /api/v1/operation-logs` | cywk 通用操作日志(只读) |
| 前端 `/login` | 登录页(DEMO 无需) |
| 前端 `/` | 默认 redirect 到 `/cywk` |

---

## 列表响应包装(三套不一致,取值前先看)

三套系统的分页 GET 返回结构**没统一**,取数据前要先看外层字段名:

| 系统 | 列表键 | 分页/元信息 | 举例(GET /...?pageSize=2) |
|---|---|---|---|
| cywk | `items` | `total` 常见 | `{ "items": [...], "total": 22 }` |
| crm  | `list`  | 视接口 | `{ "list": [...], ... }` |
| bom  | `data`(套一层 `ok`) | 视接口 | `{ "ok": true, "data": [...] }` |

写代码解析时不要假设字段名一致——三个 controller 是三批人各自写的,历史遗留。

## 触发词 → 系统消歧

三套系统里都有"客户""供应商""产品"这类同名概念,识别意图时优先看**用户上下文**:

- 说到「餐厅/连锁/门店/收银/巡检/资产」→ 优先 cywk
- 说到「商机/合同/回款/开票/线索/销售漏斗」→ 优先 crm
- 说到「BOM/生产工单/报工/设备制造」→ 优先 bom
- 不确定时**问用户**:「你说的『客户』是 CRM 的 crm/customers 还是设备 ERP 的 bom/customers?」

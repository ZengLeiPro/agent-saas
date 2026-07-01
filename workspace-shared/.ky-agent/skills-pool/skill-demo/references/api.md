# API 参考

本文件是 skill-demo 的实操参考，来源于 `skill-unified-demo` controller/DTO 与线上只读验证。线上 Swagger 生产环境关闭，遇到字段错误时先用 GET 查看真实响应，再按源码更新本文件。

## 通用约定

- API base：`https://fc.kaiyan.net/skill-demo/api/v1`
- 鉴权：`POST /auth/token` 无 body 签发 demo token；`crud.mjs` 自动处理。
- 分页常用参数：`page`、`pageSize`、`keyword`、`sortBy`、`sortOrder`
- CRM 列表常见返回：`{ list, total, page, pageSize }`
- cywk 列表常见返回：`{ items, total }`
- bom 列表常见返回：`{ ok: true, data }`
- 新增/修改后必须 GET 复核，不要只相信写入响应。

## 全局

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `auth/token` | 免密获取 demo token |
| `GET` | `auth/me` | 获取当前 demo 用户 |
| `GET` | `health` | 健康检查 |
| `GET` | `operation-logs` | 公共操作日志 |

## CRM

CRM 更新使用 `PATCH /crm/<resource>/:id`。

| 资源 | 路径 | 页面 | 方法 |
|---|---|---|---|
| 客户 | `crm/customers` | `/crm/customers` | GET/POST/PATCH/DELETE |
| 联系人 | `crm/contacts` | `/crm/contacts` | GET/POST/PATCH/DELETE |
| 商机 | `crm/opportunities` | `/crm/opportunities` | GET/POST/PATCH/DELETE |
| 合同 | `crm/contracts` | `/crm/contracts` | GET/POST/PATCH/DELETE |
| 回款 | `crm/payments` | `/crm/payments` | GET/POST/PATCH/DELETE |
| 发票 | `crm/invoices` | `/crm/invoices` | GET/POST/PATCH/DELETE |
| 跟进 | `crm/follow-ups` | `/crm/follow-ups` | GET/POST/PATCH/DELETE |
| 拜访 | `crm/visits` | `/crm/visits` | GET/POST/PATCH/DELETE |
| 产品 | `crm/products` | `/crm/products` | GET/POST/PATCH/DELETE |

### CRM 常用字段

**客户 `crm/customers`**

- 新增必填：`name`
- 可选：`industry`、`level`、`source`、`address`、`website`、`remark`、`ownerId`
- 查询过滤：`keyword`、`level`、`ownerId`
- 示例：
  ```json
  {"name":"泉州演示客户","industry":"制造业","level":"A","source":"演示录入"}
  ```

**联系人 `crm/contacts`**

- 新增必填：`customerId`、`name`
- 可选：`title`、`phone`、`email`、`isPrimary`、`remark`
- 查询过滤：`customerId`

**商机 `crm/opportunities`**

- 常用字段：`name`、`customerId`、`stage`、`amount`、`expectedCloseDate`、`ownerId`、`remark`
- 先 GET `crm/customers` 定位 `customerId`，再创建商机。

**合同 `crm/contracts`**

- 新增必填：`name`、`customerId`、`items`
- 可选：`no`、`opportunityId`、`signedAt`、`status`、`ownerId`、`remark`
- `items` 至少 1 条：`productId`、`quantity`、`unitPrice`
- 创建合同前先 GET `crm/products` 取 `productId`。

**回款 `crm/payments`**

- 常用字段：`contractId`、`amount`、`paidAt`、`method`、`remark`
- 创建前先 GET `crm/contracts` 定位 `contractId`。

**发票 `crm/invoices`**

- 常用字段：`contractId`、`amount`、`type`、`status`、`issuedAt`、`remark`

**跟进 `crm/follow-ups`**

- 常用字段：`customerId`、`opportunityId`、`type`、`content`、`nextAt`

**拜访 `crm/visits`**

- 常用字段：`customerId`、`address`、`visitedAt`、`summary`、`longitude`、`latitude`

**产品 `crm/products`**

- 常用字段：`name`、`category`、`price`、`unit`、`status`、`description`

## cywk 餐饮 ERP

cywk 更新使用 `PUT /cywk/<resource>/:id`。

| 资源 | 路径 | 页面 | 方法 |
|---|---|---|---|
| 门店 | `cywk/stores` | `/cywk/stores` | GET/POST/PUT/DELETE |
| 仓库 | `cywk/warehouses` | `/cywk/warehouses` | GET/POST/PUT/DELETE |
| 产品分类 | `cywk/product-categories` | `/cywk/product-categories` | GET/POST/PUT/DELETE |
| 产品 | `cywk/products` | `/cywk/products` | GET/POST/PUT/DELETE |
| 供应商 | `cywk/suppliers` | `/cywk/suppliers` | GET/POST/PUT/DELETE |
| 采购订单 | `cywk/purchase-orders` | `/cywk/purchase-orders` | GET/POST/PUT/DELETE |
| 采购入库 | `cywk/purchase-inbound` | `/cywk/purchase-inbound` | GET/POST/PUT/DELETE |
| 仓库出库 | `cywk/warehouse-outbounds` | `/cywk/warehouse-outbounds` | GET/POST/PUT/DELETE |
| 库存 | `cywk/inventory` | `/cywk/inventory` | GET/POST/PUT/DELETE |
| 门店要货 | `cywk/store-order-requests` | `/cywk/store-order-requests` | GET/POST/PUT/DELETE |
| 收银数据 | `cywk/cashier-orders` | `/cywk/cashier-orders` | GET/POST/PUT/DELETE |
| 巡检标准 | `cywk/inspection-standards` | `/cywk/inspection-standards` | GET/POST/PUT/DELETE |
| 巡检记录 | `cywk/inspection-records` | `/cywk/inspection-records` | GET/POST/PUT/DELETE |
| 资产分类 | `cywk/asset-categories` | `/cywk/asset-categories` | GET/POST/PUT/DELETE |
| 固定资产 | `cywk/fixed-assets` | `/cywk/fixed-assets` | GET/POST/PUT/DELETE |
| 资产调拨 | `cywk/asset-transfers` | `/cywk/asset-transfers` | GET/POST/PUT/DELETE |
| 资产报废 | `cywk/asset-disposals` | `/cywk/asset-disposals` | GET/POST/PUT/DELETE |
| 工作台 | `cywk/dashboard/overview` | `/cywk` | GET |

### cywk 操作提示

- 新增业务单据前先查询关联主数据，例如门店、仓库、产品、供应商。
- 产品/库存/采购/出库类字段较多，若不确定字段，先 GET 一条同类记录，按返回结构构造最小 body。
- 查询分析时优先使用列表数据聚合，例如库存预警、门店分布、采购状态分布。

## bom 设备 ERP

bom 多数接口是从 Express 迁移来的轻量 API，部分资源只读。响应通常为 `{ ok, data, msg }`。

| 资源 | 路径 | 页面 | 方法 |
|---|---|---|---|
| 客户 | `bom/customers` | `/bom/sales/customers` | GET |
| 供应商 | `bom/suppliers` | `/bom/procurement/suppliers` | GET |
| 库存 | `bom/stock` | `/bom/inventory/stock` | GET |
| 出入库 | `bom/moves` | `/bom/inventory/in-out` | GET/POST/DELETE |
| 采购订单 | `bom/purchase-orders` | `/bom/procurement/po` | GET/POST |
| 采购入库动作 | `bom/purchase-orders/:id/receive` | `/bom/procurement/po` | POST |
| 销售订单 | `bom/sales-orders` | `/bom/sales/so` | GET/POST |
| 生产工单 | `bom/work-orders` | `/bom/production/work-orders` | GET/POST/DELETE |
| 报工动作 | `bom/work-orders/:id/report` | `/bom/production/report` | POST |
| 销售出库 | `bom/shipments` | `/bom/inventory/shipment` | POST |

### bom 常用写入字段

- `bom/sales-orders` POST：`customer`、`product`、`qty`、`amount`
- `bom/work-orders` POST：`soId` 必填；可选 `workCenter`、`priority`
- `bom/work-orders/:id/report` POST：无 body，把待报工工单转为已入库并增加成品库存
- `bom/purchase-orders/:id/receive` POST：无 body，把待入库采购订单转为已入库并增加库存
- `bom/moves` POST：先 GET 同类记录参考字段；常见字段包括 `type`、`partNo`、`name`、`warehouse`、`unit`、`qty`、`dir`、`operator`

## 分析示例

**查 CRM A 级客户数量**

```bash
node "$SKILL_DIR/scripts/crud.mjs" get "crm/customers?page=1&pageSize=100&level=A"
```

**查设备库存**

```bash
node "$SKILL_DIR/scripts/crud.mjs" get "bom/stock"
```

**新建客户并给链接**

```bash
node "$SKILL_DIR/scripts/crud.mjs" post crm/customers --data '{"name":"泉州演示客户","industry":"制造业","level":"A"}'
node "$SKILL_DIR/scripts/crud.mjs" get "crm/customers?keyword=泉州演示客户"
node "$SKILL_DIR/scripts/open-page.mjs" /crm/customers
```

/**
 * 附录 I 向量：六个 `aph` 向量与三个拒绝向量。
 *
 * 这些值由总控用参考实现独立复算过，实现必须逐个通过；
 * **任何不一致都是实现错，不得改向量**。server / cli 复用本文件驱动一致性测试。
 */
import type { JcsErrorCode } from './jcs.js';

export interface AphVector {
  /** 用例名，供测试与 doctor 输出。 */
  name: string;
  /** `{cap, input}` 的原始 JSON 文本（先过 parseIJson 再 canonicalize）。 */
  json: string;
  /** 期望的 canonical 形式；只有需要强调规范化效果的向量才给出。 */
  canonical?: string;
  /** 期望的 aph（lowercase hex sha256）。 */
  aph: string;
}

export const APH_VECTORS: readonly AphVector[] = [
  {
    name: 'order.create 基本对象与数组内键排序',
    json: '{"cap":"order.create","input":{"customerId":"C001","lines":[{"qty":2,"sku":"A-1"}]}}',
    canonical:
      '{"cap":"order.create","input":{"customerId":"C001","lines":[{"qty":2,"sku":"A-1"}]}}',
    aph: 'ce4fb584cb7e1e50362f109ac42b140a55514ffd32683df207bb86bd10f31e89',
  },
  {
    name: 'kb.search 中文与空格',
    json: '{"cap":"kb.search","input":{"limit":10,"query":"华恒 推土机 履带 价格"}}',
    canonical: '{"cap":"kb.search","input":{"limit":10,"query":"华恒 推土机 履带 价格"}}',
    aph: 'e6dd65c7771bc3582aaae7bf629992b451c7470af4166232acd12a5f9ecc6a3f',
  },
  {
    name: 'order.create 含 emoji 与转义引号',
    json: '{"cap":"order.create","input":{"customerId":"C002","lines":[{"qty":1,"sku":"B"}],"note":"含 emoji 😀 与 \\"引号\\""}}',
    aph: '158a4d683a3bc0992a9e04294276daa5eddb274cdad274bd44a5ecd23afedaf6',
  },
  {
    name: 'price.quote 小数与整数',
    json: '{"cap":"price.quote","input":{"price":1.5,"qty":10}}',
    canonical: '{"cap":"price.quote","input":{"price":1.5,"qty":10}}',
    aph: 'd844a2b507d5df16af66cc60619a87d8488b1fc9d1742027a600f4403ad5d15e',
  },
  {
    name: '-0 规范化为 0',
    json: '{"cap":"x","input":{"z":-0}}',
    canonical: '{"cap":"x","input":{"z":0}}',
    aph: '03a07461c72d0bdb900fd734f179d4bf0a78d1185abad8596b881d3b100d9818',
  },
  {
    name: '最大安全整数',
    json: '{"cap":"x","input":{"big":9007199254740991}}',
    canonical: '{"cap":"x","input":{"big":9007199254740991}}',
    aph: '556092223e202d690068608e7e791ae6005a828eb05bc390dcb1994080124460',
  },
];

export interface RejectVector {
  name: string;
  json: string;
  code: JcsErrorCode;
}

export const REJECT_VECTORS: readonly RejectVector[] = [
  { name: '重复键', json: '{"a":1,"a":2}', code: 'duplicate_key' },
  { name: '超出安全整数', json: '{"n":9007199254740993}', code: 'unsafe_integer' },
  { name: '孤立代理项', json: '{"s":"\\ud800"}', code: 'lone_surrogate' },
];

/** 附录 A 的示例 manifest，doctor 与测试共用。 */
export const EXAMPLE_MANIFEST = {
  contractVersion: 1,
  systemId: 'demo-erp',
  name: '演示 ERP',
  icon: 'package',
  roles: { adminRole: 'admin' },
  pathPrefixes: { user: ['/api/app/'], admin: ['/api/admin/'] },
  externalLinkHosts: [],
  capabilities: [
    {
      id: 'order.search',
      name: '查询订单',
      description: '按客户名或订单号查询销售订单；返回订单号、客户、金额、状态，最多 10 条，可翻页',
      riskLevel: 'read_only',
      approval: 'none',
      safeToRetry: true,
      timeoutMs: 12000,
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '客户名或订单号' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
          cursor: { type: 'string' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                orderId: { type: 'string' },
                customer: { type: 'string' },
                amount: { type: 'number' },
                status: { type: 'string' },
              },
              required: ['orderId'],
              additionalProperties: false,
            },
          },
          hasMore: { type: 'boolean' },
          nextCursor: { type: 'string' },
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
      resultLink: { path: '/orders/{data.orderId}', label: '在系统中打开订单' },
    },
    {
      id: 'order.create',
      name: '创建订单',
      description: '为指定客户创建销售订单草稿；返回订单号',
      riskLevel: 'external_write',
      approval: 'required',
      safeToRetry: false,
      timeoutMs: 15000,
      inputSchema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          lines: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
              required: ['sku', 'qty'],
              additionalProperties: false,
            },
          },
        },
        required: ['customerId', 'lines'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
        additionalProperties: false,
      },
      resultLink: { path: '/orders/{data.orderId}', label: '在系统中打开订单' },
    },
  ],
  skills: [],
} as const;

/** 附录 B 的两个 SAT claims 示例（不含签名，只用于 claims 矩阵测试）。 */
export const EXAMPLE_SAT_USER_CLAIMS = {
  iss: 'https://agent.kaiyan.net',
  aud: 'demo-erp',
  tid: 't_demo',
  iid: 'tsi_01',
  sub: 'u_8f3a',
  act: 'user',
  tadm: true,
  pfx: ['/api/app/', '/api/admin/'],
  name: '张三',
  iat: 1788540000,
  nbf: 1788540000,
  exp: 1788540300,
  jti: 'MDAwMTExMjIyMzMzNDQ0NTU1',
} as const;

export const EXAMPLE_SAT_AGENT_CLAIMS = {
  iss: 'https://agent.kaiyan.net',
  aud: 'demo-erp',
  tid: 't_demo',
  iid: 'tsi_01',
  sub: 'u_8f3a',
  act: 'agent',
  tadm: false,
  cap: 'order.create',
  lcid: 'lc_9c2',
  dig: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  sid: 'sess_77',
  rid: 'req_x',
  apr: 'apv_12',
  aph: 'ce4fb584cb7e1e50362f109ac42b140a55514ffd32683df207bb86bd10f31e89',
  iat: 1788540000,
  nbf: 1788540000,
  exp: 1788540060,
  jti: 'MDAwMTExMjIyMzMzNDQ0NTU2',
} as const;

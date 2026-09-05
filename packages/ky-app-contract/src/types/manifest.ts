/** 附录 A：manifest 与能力定义的 TypeScript 形态。 */

/** 模型可见的能力 schema 子集（§4.5）：只允许这些 type。 */
export const CAPABILITY_SCHEMA_TYPES = [
  'object',
  'array',
  'string',
  'integer',
  'number',
  'boolean',
] as const;
export type CapabilitySchemaType = (typeof CAPABILITY_SCHEMA_TYPES)[number];

/** 模型可见的能力 schema 子集（§4.5）：只允许这些关键字。 */
export const CAPABILITY_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
  'description',
  'default',
] as const;
export type CapabilitySchemaKeyword = (typeof CAPABILITY_SCHEMA_KEYWORDS)[number];

/**
 * 明确禁止的关键字（§4.5）。白名单已经能拦住它们，单独列出是为了给出可读的报错，
 * 也记住 08-23 事故：OpenAI 拒绝含 Unicode property escapes 的 `pattern`。
 */
export const CAPABILITY_SCHEMA_FORBIDDEN_KEYWORDS = [
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'format',
  'pattern',
] as const;

export type RiskLevel = 'read_only' | 'external_write';
export type ApprovalMode = 'none' | 'required';

/** 能力的 inputSchema / outputSchema：JSON Schema 子集，用宽类型承载，语义由 validateManifest 校验。 */
export type CapabilityJsonSchema = Record<string, unknown>;

export interface ResultLink {
  /** `/orders/{data.orderId}`：占位须存在于 outputSchema 且为 string/integer。 */
  path: string;
  label: string;
}

export interface ManifestCapability {
  id: string;
  name: string;
  description: string;
  riskLevel: RiskLevel;
  approval: ApprovalMode;
  safeToRetry: boolean;
  timeoutMs?: number;
  inputSchema: CapabilityJsonSchema;
  outputSchema: CapabilityJsonSchema;
  resultLink?: ResultLink | null;
}

export interface ManifestPathPrefixes {
  user: string[];
  admin: string[];
}

export interface ManifestSkill {
  path: string;
}

export interface Manifest {
  contractVersion: 1;
  systemId: string;
  name: string;
  description?: string;
  icon?: string;
  roles: { adminRole: string };
  pathPrefixes: ManifestPathPrefixes;
  externalLinkHosts?: string[];
  ui?: { routeSync?: boolean; theme?: boolean };
  capabilities: ManifestCapability[];
  skills?: ManifestSkill[];
}

/** 附录 J：`ky-app.conformance.json` 夹具（不进 manifest、不进模型）。 */
export interface ConformanceUser {
  sub: string;
  tadm?: boolean;
  roles?: string[];
}

export interface ConformanceCapabilityFixture {
  validInputs: Array<{ input: Record<string, unknown>; expect?: Record<string, unknown> }>;
  invalidInputs?: Array<{ input: Record<string, unknown>; expectCode: string }>;
  cleanup?: { capabilityId: string; input: Record<string, unknown> };
  pageApiEquivalence?: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, unknown>;
    idField: string;
    capabilityInput: Record<string, unknown>;
  };
}

export interface ConformanceFixture {
  contractVersion: 1;
  users: { admin: ConformanceUser; member: ConformanceUser; norole: ConformanceUser };
  capabilities: Record<string, ConformanceCapabilityFixture>;
  endpoints: string[];
  /**
   * 菜单叶子 → 页面接口。§9.3-8 要求「无权用户访问每个菜单接口 → 403」，
   * 而附录 C 的 `/me` 里只有前端 path、没有接口地址，故在夹具里显式声明。
   */
  menuApis?: Record<string, { method: 'GET' | 'POST'; path: string }>;
}

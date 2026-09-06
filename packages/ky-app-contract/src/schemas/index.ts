/**
 * 附录 A/C/D/J/L 五份 JSON Schema 的编译入口。
 *
 * 契约自身的 schema 可以自由使用 `$ref/$defs/allOf/if/then`（§4.5 明确豁免）；
 * 受「能力 schema 子集」约束的只有 manifest 实例里的 inputSchema / outputSchema。
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import conformanceSchemaJson from './ky-app-conformance.v1.json' with { type: 'json' };
import directorySchemaJson from './ky-app-directory.v1.json' with { type: 'json' };
import errorSchemaJson from './ky-app-error.v1.json' with { type: 'json' };
import manifestSchemaJson from './ky-app-manifest.v1.json' with { type: 'json' };
import meSchemaJson from './ky-app-me.v1.json' with { type: 'json' };

/** JSON Schema 文档的宽类型，避免 d.ts 里内联整份 schema 的字面量类型。 */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export const manifestSchema: JsonSchemaDocument = manifestSchemaJson;
export const meSchema: JsonSchemaDocument = meSchemaJson;
export const errorSchema: JsonSchemaDocument = errorSchemaJson;
export const conformanceSchema: JsonSchemaDocument = conformanceSchemaJson;
export const directorySchema: JsonSchemaDocument = directorySchemaJson;

export const SCHEMA_IDS = {
  manifest: 'https://agent.kaiyan.net/schemas/ky-app-manifest/v1.json',
  me: 'https://agent.kaiyan.net/schemas/ky-app-me/v1.json',
  error: 'https://agent.kaiyan.net/schemas/ky-app-error/v1.json',
  conformance: 'https://agent.kaiyan.net/schemas/ky-app-conformance/v1.json',
  directory: 'https://agent.kaiyan.net/schemas/ky-app-directory/v1.json',
} as const;

/** 全部 schema 文档，按 $id 索引，便于消费方自行编译或对外发布。 */
export const SCHEMAS: Readonly<Record<string, JsonSchemaDocument>> = {
  [SCHEMA_IDS.manifest]: manifestSchema,
  [SCHEMA_IDS.me]: meSchema,
  [SCHEMA_IDS.error]: errorSchema,
  [SCHEMA_IDS.conformance]: conformanceSchema,
  [SCHEMA_IDS.directory]: directorySchema,
};

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

// ajv 是 CJS：moduleResolution=NodeNext 下默认导入拿到的是 module.exports 命名空间，
// 构造函数挂在 .default 上（ajv 同时把类本体赋给 module.exports，两种取法运行时等价）。
// WP2a：agent-saas 的 server 工作区用 moduleResolution=bundler + esModuleInterop 引用本包源码，
// 那里默认导入被定型成构造函数本体（没有 .default）。两种模块解析下都要能编译，
// 因此按值取 .default、取不到回落到命名空间本身，并显式声明本文件真正用到的最小接口。
interface Ajv2020Instance {
  addSchema(schema: unknown): unknown;
  getSchema(keyRef: string): ValidateFunction | undefined;
}
type Ajv2020Constructor = new (options: { allErrors: boolean; strict: boolean }) => Ajv2020Instance;
const Ajv2020 = ((Ajv2020Module as { default?: unknown }).default ??
  Ajv2020Module) as unknown as Ajv2020Constructor;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(errorSchemaJson);
ajv.addSchema(manifestSchemaJson);
ajv.addSchema(meSchemaJson);
ajv.addSchema(conformanceSchemaJson);
ajv.addSchema(directorySchemaJson);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['schema 校验失败但未给出细节'];
  return errors.map((error) => {
    const where = error.instancePath === '' ? '/' : error.instancePath;
    const extra =
      error.keyword === 'additionalProperties'
        ? ` (${String(error.params.additionalProperty)})`
        : '';
    return `${where} ${error.message ?? error.keyword}${extra}`;
  });
}

function requireSchema(ref: string): ValidateFunction {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`schema 未注册：${ref}`);
  return validate;
}

function toValidator(ref: string): (value: unknown) => SchemaValidationResult {
  let cached: ValidateFunction | undefined;
  return (value: unknown): SchemaValidationResult => {
    cached ??= requireSchema(ref);
    const ok = cached(value) as boolean;
    return ok ? { ok: true, errors: [] } : { ok: false, errors: formatErrors(cached.errors) };
  };
}

/** 附录 A：manifest 结构校验（不含 §4.5 附加语义校验，那部分在 validateManifest()）。 */
export const validateManifestSchema = toValidator(SCHEMA_IDS.manifest);

/** 附录 C：`/ky/v1/me` 结构校验（不含语义校验，那部分在 validateMe()）。 */
export const validateMeSchema = toValidator(SCHEMA_IDS.me);

/** 附录 D：错误响应体。 */
export const validateErrorResponse = toValidator(SCHEMA_IDS.error);

/** 附录 J：`ky-app.conformance.json` 夹具。 */
export const validateConformance = toValidator(SCHEMA_IDS.conformance);

/** 附录 L：目录快照。 */
export const validateDirectorySnapshot = toValidator(`${SCHEMA_IDS.directory}#/$defs/snapshot`);

/** 附录 L：目录变更流。 */
export const validateDirectoryChanges = toValidator(`${SCHEMA_IDS.directory}#/$defs/changes`);

/** 附录 L：单条目录事件。 */
export const validateDirectoryEvent = toValidator(`${SCHEMA_IDS.directory}#/$defs/event`);

/** 附录 L：410 响应。 */
export const validateDirectoryGone = toValidator(`${SCHEMA_IDS.directory}#/$defs/error410`);

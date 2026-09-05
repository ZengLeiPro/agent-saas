/**
 * §4.5「能力 schema 子集」的运行时校验器。
 *
 * 只实现 manifest 允许出现的关键字（`type / properties / required / additionalProperties /
 * items / enum / const / minimum / maximum / minLength / maxLength / maxItems /
 * description / default`）。**刻意不用 ajv**：子集极小，自己实现可以让本包不依赖 ajv，
 * 也从结构上保证 `pattern` / `format` 这类被规范禁用的关键字永远不会被执行
 * （08-23 事故：OpenAI 拒绝含 Unicode property escapes 的 `pattern`）。
 * manifest 里出现禁用关键字由 contract 的 `validateManifest()` 在装载期拒掉。
 */
import { CAPABILITY_SCHEMA_TYPES, type CapabilityJsonSchema } from '@kaiyan/ky-app-contract';

export interface SubsetValidationResult {
  ok: boolean;
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function checkScalarBounds(
  schema: CapabilityJsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: 小于 minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: 大于 maximum ${schema.maximum}`);
    }
  }
  if (typeof value === 'string') {
    // 长度按 Unicode 码点计，避免代理对被算成两个字符。
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      errors.push(`${path}: 长度小于 minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      errors.push(`${path}: 长度大于 maxLength ${schema.maxLength}`);
    }
  }
}

function walk(schema: CapabilityJsonSchema, value: unknown, path: string, errors: string[]): void {
  const expected = schema.type;
  if (typeof expected === 'string') {
    if (!(CAPABILITY_SCHEMA_TYPES as readonly string[]).includes(expected)) {
      errors.push(`${path}: schema 使用了子集外的 type ${expected}`);
      return;
    }
    if (!matchesType(expected, value)) {
      errors.push(`${path}: 期望 ${expected}，实际 ${typeOf(value)}`);
      return;
    }
  }

  if (Object.hasOwn(schema, 'const') && !deepEqual(schema.const, value)) {
    errors.push(`${path}: 取值必须是 const 指定的值`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path}: 取值不在 enum 内`);
  }
  checkScalarBounds(schema, value, path, errors);

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: 元素数大于 maxItems ${schema.maxItems}`);
    }
    const items = schema.items;
    if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
      value.forEach((item, index) => {
        walk(items as CapabilityJsonSchema, item, `${path}[${index}]`, errors);
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, CapabilityJsonSchema>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(record, key)) errors.push(`${path}: 缺少必填字段 ${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}: 不允许的字段 ${key}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) continue;
      walk(child, record[key], `${path}.${key}`, errors);
    }
  }
}

/** 按 §4.5 子集校验一个值。`schema` 必须已经通过 contract 的 `validateManifest()`。 */
export function validateAgainstCapabilitySchema(
  schema: CapabilityJsonSchema,
  value: unknown,
  label = 'input',
): SubsetValidationResult {
  const errors: string[] = [];
  walk(schema, value, label, errors);
  return { ok: errors.length === 0, errors };
}

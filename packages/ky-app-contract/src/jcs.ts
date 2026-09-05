/**
 * Canonical JSON（RFC 8785 JCS）与 I-JSON 严格解析（附录 I）。
 *
 * 两层校验：
 * 1. parseIJson(text)：严格解析器，在**文本层**拒重复键、拒超出 ±(2^53-1) 的整数字面量、
 *    拒孤立代理项、拒非有限数。
 * 2. canonicalize(value)：对**已解析值**再检一遍（非有限数、Number.isInteger 且非安全整数、
 *    孤立代理项、非普通对象/数组），再按 JCS 序列化。
 *
 * 附录 I 六个向量由总控独立复算过，实现必须逐个通过；不一致 = 实现错，不得改向量。
 */

export type JcsErrorCode =
  | 'invalid_json'
  | 'duplicate_key'
  | 'unsafe_integer'
  | 'lone_surrogate'
  | 'non_finite_number'
  | 'unsupported_type';

export class JcsError extends Error {
  readonly code: JcsErrorCode;
  /** 出错处在输入文本中的偏移（仅解析期错误有值）。 */
  readonly offset?: number;

  constructor(code: JcsErrorCode, message: string, offset?: number) {
    super(message);
    this.name = 'JcsError';
    this.code = code;
    this.offset = offset;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** 检出孤立代理项（未配对的 D800–DFFF）。 */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785 §3.2.2.3：数字按 ES6 Number::toString，`-0` → `0`。 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new JcsError('non_finite_number', `非有限数不满足 I-JSON：${String(value)}`);
  }
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new JcsError('unsafe_integer', `整数超出 ±(2^53-1)：${String(value)}`);
  }
  return String(value);
}

function serializeString(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new JcsError('lone_surrogate', '字符串含孤立代理项，不满足 I-JSON');
  }
  // JSON.stringify 的转义规则与 RFC 8785 §3.2.2.2 一致（\b \t \n \f \r \" \\ 与 \u00xx）。
  return JSON.stringify(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return serializeString(value);
    case 'object':
      break;
    default:
      throw new JcsError('unsupported_type', `JSON 不支持的类型：${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new JcsError('unsupported_type', '只接受普通对象与数组，不接受类实例 / Map / Date 等');
  }
  // RFC 8785 §3.2.3：键按 UTF-16 code unit 升序；JS 默认字符串排序正是 code unit 比较。
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) {
      // 静默丢弃会改变哈希，这里显式拒绝，保证同一份数据在两端算出同一个 aph。
      throw new JcsError('unsupported_type', `属性 ${key} 的值是 undefined，不是 JSON 值`);
    }
    parts.push(`${serializeString(key)}:${serialize(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 把已解析的 JSON 值序列化为 RFC 8785 canonical 形式。 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * I-JSON 严格解析器。与 JSON.parse 的差别：
 * - 对象内重复键直接拒绝（JSON.parse 是后者胜）；
 * - 整数字面量用 BigInt 比较，超出 ±(2^53-1) 拒绝（JSON.parse 会静默丢精度）；
 * - 结果为非有限数（如 1e999）拒绝；
 * - 字符串含孤立代理项拒绝。
 */
export function parseIJson(text: string): unknown {
  let index = 0;

  const fail = (code: JcsErrorCode, message: string): never => {
    throw new JcsError(code, `${message}（偏移 ${index}）`, index);
  };

  const skipWhitespace = (): void => {
    while (index < text.length && WHITESPACE.has(text[index] as string)) index += 1;
  };

  const expect = (char: string): void => {
    if (text[index] !== char) fail('invalid_json', `期望 ${char}`);
    index += 1;
  };

  const parseLiteral = (literal: string, value: unknown): unknown => {
    if (text.slice(index, index + literal.length) !== literal) fail('invalid_json', '非法字面量');
    index += literal.length;
    return value;
  };

  const parseHex4 = (): number => {
    const hex = text.slice(index, index + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail('invalid_json', '非法 \\u 转义');
    index += 4;
    return Number.parseInt(hex, 16);
  };

  const parseString = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      if (index >= text.length) fail('invalid_json', '字符串未闭合');
      const char = text[index] as string;
      if (char === '"') {
        index += 1;
        if (hasLoneSurrogate(out)) fail('lone_surrogate', '字符串含孤立代理项');
        return out;
      }
      if (char === '\\') {
        index += 1;
        const escape = text[index];
        if (escape === undefined) fail('invalid_json', '转义未闭合');
        if (escape === 'u') {
          index += 1;
          out += String.fromCharCode(parseHex4());
          continue;
        }
        const mapped = ESCAPES[escape as string];
        if (mapped === undefined) fail('invalid_json', `非法转义 \\${escape as string}`);
        out += mapped;
        index += 1;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) fail('invalid_json', '字符串内出现未转义控制字符');
      out += char;
      index += 1;
    }
  };

  const parseNumber = (): number => {
    const start = index;
    if (text[index] === '-') index += 1;
    if (text[index] === '0') {
      index += 1;
    } else if (text[index] !== undefined && text[index]! >= '1' && text[index]! <= '9') {
      while (text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9') index += 1;
    } else {
      fail('invalid_json', '非法数字');
    }
    let isInteger = true;
    if (text[index] === '.') {
      isInteger = false;
      index += 1;
      if (!(text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9')) {
        fail('invalid_json', '小数点后缺少数字');
      }
      while (text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9') index += 1;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      isInteger = false;
      index += 1;
      if (text[index] === '+' || text[index] === '-') index += 1;
      if (!(text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9')) {
        fail('invalid_json', '指数缺少数字');
      }
      while (text[index] !== undefined && text[index]! >= '0' && text[index]! <= '9') index += 1;
    }
    const literal = text.slice(start, index);
    if (isInteger) {
      const big = BigInt(literal);
      if (big > MAX_SAFE || big < MIN_SAFE)
        fail('unsafe_integer', `整数超出 ±(2^53-1)：${literal}`);
    }
    const value = Number(literal);
    if (!Number.isFinite(value)) fail('non_finite_number', `数字不是有限数：${literal}`);
    return value;
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const char = text[index];
    if (char === undefined) return fail('invalid_json', '输入意外结束');
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't') return parseLiteral('true', true);
    if (char === 'f') return parseLiteral('false', false);
    if (char === 'n') return parseLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    return fail('invalid_json', `非法字符 ${char}`);
  };

  function parseObject(): Record<string, unknown> {
    expect('{');
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return { ...out };
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (seen.has(key)) fail('duplicate_key', `对象内重复键 ${key}`);
      seen.add(key);
      skipWhitespace();
      expect(':');
      out[key] = parseValue();
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      expect('}');
      return { ...out };
    }
  }

  function parseArray(): unknown[] {
    expect('[');
    const out: unknown[] = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      expect(']');
      return out;
    }
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail('invalid_json', '尾部有多余内容');
  return value;
}

/** 先按 I-JSON 严格解析再 canonical 化，用于处理来自网络的 JSON 文本。 */
export function canonicalizeText(text: string): string {
  return canonicalize(parseIJson(text));
}

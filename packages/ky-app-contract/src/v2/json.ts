import { v2Fail } from './errors.js';

/** 在 JSON.parse 前拒绝对象中的重复 key，避免同一 token 被不同实现解释成不同 claims。 */
export function parseJsonWithoutDuplicateKeys(text: string): unknown {
  let position = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[position] ?? '')) position += 1;
  };
  const parseString = (): string => {
    const start = position;
    if (text[position] !== '"') return v2Fail('malformed_jose', 'json', '应为 JSON 字符串');
    position += 1;
    while (position < text.length) {
      const char = text[position];
      if (char === '\\') {
        position += 2;
        continue;
      }
      position += 1;
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, position)) as string;
        } catch {
          return v2Fail('malformed_jose', 'json', 'JSON 字符串转义不合法');
        }
      }
    }
    return v2Fail('malformed_jose', 'json', 'JSON 字符串未结束');
  };
  const parseValue = (): void => {
    skipWhitespace();
    const char = text[position];
    if (char === '{') {
      parseObject();
      return;
    }
    if (char === '[') {
      parseArray();
      return;
    }
    if (char === '"') {
      parseString();
      return;
    }
    const match = text
      .slice(position)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
    if (!match) return v2Fail('malformed_jose', 'json', 'JSON value 不合法');
    position += match[0].length;
  };
  const parseObject = (): void => {
    position += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[position] === '}') {
      position += 1;
      return;
    }
    while (position < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) return v2Fail('malformed_jose', 'json', `重复 JSON key: ${key}`);
      keys.add(key);
      skipWhitespace();
      if (text[position] !== ':') return v2Fail('malformed_jose', 'json');
      position += 1;
      parseValue();
      skipWhitespace();
      if (text[position] === '}') {
        position += 1;
        return;
      }
      if (text[position] !== ',') return v2Fail('malformed_jose', 'json');
      position += 1;
    }
    return v2Fail('malformed_jose', 'json');
  };
  const parseArray = (): void => {
    position += 1;
    skipWhitespace();
    if (text[position] === ']') {
      position += 1;
      return;
    }
    while (position < text.length) {
      parseValue();
      skipWhitespace();
      if (text[position] === ']') {
        position += 1;
        return;
      }
      if (text[position] !== ',') return v2Fail('malformed_jose', 'json');
      position += 1;
    }
    return v2Fail('malformed_jose', 'json');
  };

  try {
    parseValue();
    skipWhitespace();
    if (position !== text.length) return v2Fail('malformed_jose', 'json');
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === 'V2ContractError') throw error;
    return v2Fail('malformed_jose', 'json');
  }
}

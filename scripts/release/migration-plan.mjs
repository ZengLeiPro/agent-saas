import { createHash } from 'node:crypto';
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import ts from 'typescript';
import { canonicalJson, SHA_PATTERN } from './artifact-lib.mjs';

const MIGRATION_PATHS = [
  /^server\/src\/data\/(?:.+\/)?migrations?\.ts$/u,
  /^server\/src\/data\/(?:.+\/)?migrate\.ts$/u,
  /^server\/src\/context\/(?:.+\/)?migration\.ts$/u,
  /^server\/scripts\/migrate-[^/]+\.mts$/u,
  /(?:^|\/)migrations?\/(?:.+)$/u,
];
// 只有独立注释显式标为 expand，且 SQL/调用形态全部落在白名单内，才可晋级。
const EXPAND_METADATA = /^release-migration\s*:\s*expand$/iu;
const CONTRACT_PATTERN =
  /\b(?:DROP|TRUNCATE|RENAME|DELETE|UPDATE|UPSERT|MERGE|REPLACE|REVOKE|GRANT)\b|\bSET\s+NOT\s+NULL\b|\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const DYNAMIC_SQL_PATTERN =
  /\b(?:EXECUTE(?:\s+IMMEDIATE)?|sp_executesql|CALL|UNTERMINATED_SQL_COMMENT|UNTERMINATED_SQL_STRING)\b|\bsql\.raw\b|\$(?:executeRawUnsafe|queryRawUnsafe)\b|\bformat\s*\(|\bDO\s+\$\$|(?:['"`])\s*\+|\+\s*(?:['"`])|\b(?:query|execute|[A-Za-z_$][\w$]*(?:Query|Execute))\s*\(\s*(?!['"`])/iu;
// SELECT/CTE/CALL 等非纯 schema expand 语句一律要求另走 contract 流程。
const UNKNOWN_SQL_PATTERN =
  /\b(?:SELECT|WITH|BEGIN|COMMIT|ROLLBACK|COPY|VACUUM|ANALYZE|REFRESH|LOCK|DISCARD)\b/iu;
const MIGRATION_PROVIDER_SQL_PATTERN =
  /\b(?:ALTER\s+\S+|ANALYZE(?:\s|$)|BEGIN\b|CALL\s+\S+\s*\(|COMMENT\s+ON\b|COPY\s+\S+|CREATE\s+(?:OR\s+REPLACE\s+)?\S+|DELETE\s+FROM\b|DO(?:\s|$)|DROP\s+\S+|EXECUTE\s+\S+|GRANT\b|INSERT\s+INTO\b|LOCK\s+(?:TABLE\s+)?\S+|MERGE\s+INTO\b|REASSIGN\s+OWNED\b|REFRESH\s+MATERIALIZED\s+VIEW\b|REINDEX\s+\S+|REVOKE\b|SET\s+\S+|TRUNCATE(?:\s+TABLE)?\s+\S+|UPDATE\s+(?:ONLY\s+)?\S+(?:\s+\*)?(?:\s+(?:AS\s+)?\S+)?\s+SET\b|VACUUM(?:\s|$)|SELECT\s+(?!(?:COUNT|SUM|AVG|MIN|MAX)\s*\()(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\s*\(|VALUES\s*\([^)]*(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\s*\()/iu;
const SCRIPT_MIGRATION_PATTERN = /\.(?:[cm]?[jt]s)$/iu;
const RELATIVE_MODULE_SPECIFIER = /^\.{1,2}\//u;
const GOVERNANCE_MIGRATION_PROVIDER_PATH =
  /^server\/src\/data\/governance-schema\/[^/]*migrations?\.ts$/iu;

// ADD COLUMN is parsed again as an explicit safe subset; the prefix alone never grants expand.
const ALLOWED_EXPAND_ALTER_PATTERN =
  /^ALTER\s+TABLE\s+\S+\s+(?:ADD\s+(?:COLUMN\s+)?|ADD\s+CONSTRAINT\b|VALIDATE\s+CONSTRAINT\b)/iu;
const ADD_TABLE_CONSTRAINT_PATTERN =
  /^ALTER\s+TABLE\s+\S+\s+ADD\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONSTRAINT\b|CHECK\b|NOT\s+NULL\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|EXCLUDE\b)/iu;
const ALLOWED_EXPAND_CREATE_PATTERN =
  /^CREATE\s+(?:(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?|TABLE|SEQUENCE)\b/iu;
const ALLOWED_CREATE_PAREN_KEYWORDS = new Set(['as', 'check', 'unique', 'with']);
const ALLOWED_CREATE_TYPE_MODIFIERS = new Set([
  'bit',
  'char',
  'character',
  'decimal',
  'interval',
  'numeric',
  'time',
  'timestamp',
  'varbit',
  'varchar',
]);

export function isMigrationPath(path) {
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/');
  return MIGRATION_PATHS.some((pattern) => pattern.test(normalized));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function gitRead(execFileSync, cwd, args) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8' }));
}

function isSqlIdentifierContinuation(character) {
  return (
    typeof character === 'string' &&
    (/[A-Za-z0-9_$]/u.test(character) || /[^\x00-\x7F]/u.test(character))
  );
}

function dollarQuoteTagAt(value, index) {
  if (value[index] !== '$' || isSqlIdentifierContinuation(value[index - 1])) return null;
  return (
    value
      .slice(index)
      .match(/^\$(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_]|[^\x00-\x7F])*)?\$/u)?.[0] ?? null
  );
}

function hasExpandMetadata(content, path) {
  const sqlComments = /\.(?:sql|psql)$/iu.test(path);
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (sqlComments && character === '$') {
      const dollarTag = dollarQuoteTagAt(content, index);
      if (dollarTag) {
        const end = content.indexOf(dollarTag, index + dollarTag.length);
        if (end < 0) return false;
        index = end + dollarTag.length - 1;
        continue;
      }
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < content.length) {
        if (content[index] === '\\') index += 2;
        else if (content[index] === quote) break;
        else index += 1;
      }
      continue;
    }
    if (character === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index + 2);
      const comment = content.slice(index + 2, end < 0 ? content.length : end).trim();
      if (EXPAND_METADATA.test(comment)) return true;
      index = end < 0 ? content.length : end;
      continue;
    }
    if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) return false;
      if (EXPAND_METADATA.test(content.slice(index + 2, end).trim())) return true;
      index = end + 1;
      continue;
    }
    if (sqlComments && character === '-' && content[index + 1] === '-') {
      const end = content.indexOf('\n', index + 2);
      const comment = content.slice(index + 2, end < 0 ? content.length : end).trim();
      if (EXPAND_METADATA.test(comment)) return true;
      index = end < 0 ? content.length : end;
    }
  }
  return false;
}

function isPostgresEscapeStringStart(value, quoteIndex) {
  return (
    quoteIndex > 0 &&
    /[eE]/u.test(value[quoteIndex - 1]) &&
    (quoteIndex < 2 || !isSqlIdentifierContinuation(value[quoteIndex - 2]))
  );
}

function stripSqlComments(value) {
  let output = '';
  let quote = null;
  let backslashEscapes = false;
  let dollarTag = null;
  for (let index = 0; index < value.length; index += 1) {
    if (dollarTag) {
      if (value.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else output += value[index];
      continue;
    }
    const character = value[index];
    if (quote) {
      output += character;
      if (backslashEscapes && character === '\\' && index + 1 < value.length) {
        output += value[index + 1];
        index += 1;
      } else if (character === quote) {
        if (value[index + 1] === quote) {
          output += value[index + 1];
          index += 1;
        } else {
          quote = null;
          backslashEscapes = false;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      backslashEscapes = character === "'" && isPostgresEscapeStringStart(value, index);
      output += character;
      continue;
    }
    if (character === '$') {
      const tag = dollarQuoteTagAt(value, index);
      if (tag) {
        dollarTag = tag;
        output += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === '-' && value[index + 1] === '-') {
      index += 2;
      while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && value[index + 1] === '*') {
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value[index] === '/' && value[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (value[index] === '*' && value[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) return `${output} UNTERMINATED_SQL_COMMENT `;
      index -= 1;
      output += ' ';
      continue;
    }
    output += character;
  }
  if (quote || dollarTag) return `${output} UNTERMINATED_SQL_STRING `;
  return output;
}

function maskSqlLiterals(value) {
  let output = '';
  let quote = null;
  let backslashEscapes = false;
  let dollarTag = null;
  for (let index = 0; index < value.length; index += 1) {
    if (dollarTag) {
      if (value.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    const character = value[index];
    if (quote) {
      if (backslashEscapes && character === '\\' && index + 1 < value.length) index += 1;
      else if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else {
          output += quote;
          quote = null;
          backslashEscapes = false;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      backslashEscapes = character === "'" && isPostgresEscapeStringStart(value, index);
      output += character === '"' ? '"identifier' : character;
      continue;
    }
    if (character === '$') {
      const tag = dollarQuoteTagAt(value, index);
      if (tag) {
        dollarTag = tag;
        output += tag;
        index += tag.length - 1;
        continue;
      }
    }
    output += character;
  }
  if (quote || dollarTag) return `${output} UNTERMINATED_SQL_STRING `;
  return output;
}

function normalizeSqlForClassification(value) {
  return maskSqlLiterals(stripSqlComments(value)).replace(/\s+/gu, ' ').trim();
}

function splitSqlStatements(value) {
  const sql = stripSqlComments(value);
  const statements = [];
  let start = 0;
  let quote = null;
  let backslashEscapes = false;
  let dollarTag = null;
  for (let index = 0; index < sql.length; index += 1) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    const character = sql[index];
    if (quote) {
      if (backslashEscapes && character === '\\' && index + 1 < sql.length) index += 1;
      else if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else {
          quote = null;
          backslashEscapes = false;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      backslashEscapes = character === "'" && isPostgresEscapeStringStart(sql, index);
      continue;
    }
    if (character === '$') {
      const tag = dollarQuoteTagAt(sql, index);
      if (tag) {
        dollarTag = tag;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (character === ';') {
      const statement = normalizeSqlForClassification(sql.slice(start, index));
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const trailing = normalizeSqlForClassification(sql.slice(start));
  if (trailing) statements.push(trailing);
  return statements;
}

function isAllowedExpandSqlStatement(statement) {
  if (
    CONTRACT_PATTERN.test(statement) ||
    DYNAMIC_SQL_PATTERN.test(statement) ||
    UNKNOWN_SQL_PATTERN.test(statement) ||
    /\\[A-Za-z!?]/u.test(statement) ||
    hasRiskyAddColumn(statement) ||
    hasUnprovenAddConstraint(statement) ||
    hasUnprovenAlterFunction(statement) ||
    hasUnprovenCreateFunction(statement) ||
    hasUnprovenCreateExpression(statement)
  )
    return false;
  if (ALLOWED_EXPAND_CREATE_PATTERN.test(statement)) {
    if (/^CREATE\s+TABLE\b/iu.test(statement) && hasTopLevelKeyword(statement, 'AS')) return false;
    return !hasUnknownCreate(statement);
  }
  if (ALLOWED_EXPAND_ALTER_PATTERN.test(statement))
    return !hasUnknownAlter(statement) && !hasTopLevelComma(statement);
  return false;
}

function operationSlices(value, keyword) {
  const matcher = new RegExp(`\\b${keyword}\\b`, 'giu');
  const matches = [...value.matchAll(matcher)];
  return matches.map((match) => {
    const start = match.index ?? 0;
    const semicolon = value.indexOf(';', start);
    return value.slice(start, semicolon < 0 ? value.length : semicolon);
  });
}

function hasTopLevelKeyword(value, keyword) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      value.slice(index).match(new RegExp(`^${keyword}\\b`, 'iu')) &&
      (index === 0 || !/[A-Za-z0-9_$]/u.test(value[index - 1]))
    )
      return true;
  }
  return false;
}

function hasTopLevelComma(value) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) return true;
  }
  return false;
}

function hasUnknownAlter(value) {
  return operationSlices(value, 'ALTER').some(
    (statement) => !ALLOWED_EXPAND_ALTER_PATTERN.test(statement) || hasTopLevelComma(statement),
  );
}

function hasUnknownCreate(value) {
  return operationSlices(value, 'CREATE').some(
    (statement) => !ALLOWED_EXPAND_CREATE_PATTERN.test(statement),
  );
}

function hasUnprovenCreateFunction(value) {
  if (!ALLOWED_EXPAND_CREATE_PATTERN.test(value)) return false;
  const structuralOpen = value.indexOf('(');
  const functionPattern =
    /((?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*|"(?:""|[^"])+")\s*\(/gu;
  for (const match of value.matchAll(functionPattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    if (open === structuralOpen) continue;
    const name = match[1];
    const prefix = value.slice(0, match.index);
    const qualifierMatch = prefix.match(
      /((?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*|"(?:""|[^"])+")\s*\.\s*$/u,
    );
    const qualifier = qualifierMatch?.[1];
    // Only a single explicit pg_catalog binding avoids search_path ambiguity.
    if (qualifier !== undefined) {
      const qualifierPrefix = prefix.slice(0, qualifierMatch.index).trimEnd();
      if (!qualifierPrefix.endsWith('.') && qualifier === 'pg_catalog' && name === 'lower')
        continue;
      return true;
    }
    const normalizedName = name.toLowerCase();
    const keywordContext = prefix.trimEnd();
    const allowedContextualKeyword =
      !name.startsWith('"') &&
      ((normalizedName === 'hash' && /\b(?:USING|PARTITION\s+BY)\s*$/iu.test(keywordContext)) ||
        (normalizedName === 'range' && /\bPARTITION\s+BY\s*$/iu.test(keywordContext)) ||
        (normalizedName === 'key' && /\b(?:PRIMARY|FOREIGN)\s*$/iu.test(keywordContext)) ||
        (normalizedName === 'include' && /\)\s*$/u.test(keywordContext)));
    if (allowedContextualKeyword) continue;
    const allowedKeyword =
      !name.startsWith('"') && ALLOWED_CREATE_PAREN_KEYWORDS.has(normalizedName);
    if (allowedKeyword) continue;
    // Type-like calls are safe only as direct CREATE TABLE column modifiers with numeric arity.
    if (!name.startsWith('"') && ALLOWED_CREATE_TYPE_MODIFIERS.has(normalizedName)) {
      let depth = 1;
      let segmentStart = structuralOpen + 1;
      for (let index = structuralOpen + 1; index < match.index; index += 1) {
        if (value[index] === '(') depth += 1;
        else if (value[index] === ')') depth -= 1;
        else if (value[index] === ',' && depth === 1) segmentStart = index + 1;
      }
      const columnPrefix = value.slice(segmentStart, match.index);
      const modifierClose = value.indexOf(')', open + 1);
      const modifierArguments = modifierClose === -1 ? '' : value.slice(open + 1, modifierClose);
      const directColumnType =
        /^CREATE\s+TABLE\b/iu.test(value) &&
        depth === 1 &&
        /^\s*(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*|"(?:""|[^"])+")\s+$/u.test(
          columnPrefix,
        ) &&
        /^\s*\d+(?:\s*,\s*\d+)?\s*$/u.test(modifierArguments);
      if (directColumnType) continue;
    }
    return true;
  }
  return false;
}

function matchingParenthesis(value, open) {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitSqlList(value) {
  const items = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth -= 1;
    else if (value[index] === ',' && depth === 0) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

function hasUnprovenCreateExpression(value) {
  const identifier =
    '(?:(?:[A-Za-z_]|[^\\x00-\\x7F])(?:[A-Za-z0-9_$]|[^\\x00-\\x7F])*|"(?:""|[^"])+")';
  const plainIndexKey = new RegExp(
    `^\\s*${identifier}(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?\\s*$`,
    'iu',
  );
  const builtinLowerIndexKey = new RegExp(
    `^\\s*pg_catalog\\.lower\\(\\s*${identifier}\\s*\\)(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?\\s*$`,
    'iu',
  );
  if (/^CREATE\s+(?:(?:UNIQUE\s+)?INDEX)/iu.test(value)) {
    const method = value.match(/\bUSING\s+([^\s(]+)/iu)?.[1]?.toLowerCase();
    if (method !== undefined && !['btree', 'hash'].includes(method)) return true;
    const open = value.indexOf('(');
    const close = matchingParenthesis(value, open);
    if (open === -1 || close === -1) return true;
    const keys = splitSqlList(value.slice(open + 1, close));
    if (
      keys.length === 0 ||
      keys.some((key) => !plainIndexKey.test(key) && !builtinLowerIndexKey.test(key))
    )
      return true;
    const tail = value.slice(close + 1);
    if (/\bWHERE\b/iu.test(tail) || /::/u.test(tail)) return true;
    const include = tail.match(/\bINCLUDE\s*\(/iu);
    if (include) {
      const includeOpen = close + 1 + (include.index ?? 0) + include[0].lastIndexOf('(');
      const includeClose = matchingParenthesis(value, includeOpen);
      if (
        includeClose === -1 ||
        splitSqlList(value.slice(includeOpen + 1, includeClose)).some(
          (key) => !plainIndexKey.test(key),
        )
      )
        return true;
    }
    return false;
  }
  if (/^CREATE\s+TABLE\b/iu.test(value)) {
    if (/\b(?:DEFAULT|CHECK|EXCLUDE)\b|\bPARTITION\s+BY\b|::/iu.test(value)) return true;
    // Generated expressions are executable for future writes; keep the whitelist explicit.
    for (const generated of value.matchAll(/\bGENERATED\s+ALWAYS\s+AS\s*\(/giu)) {
      const open = (generated.index ?? 0) + generated[0].lastIndexOf('(');
      const close = matchingParenthesis(value, open);
      if (close === -1) return true;
      const expression = value.slice(open + 1, close);
      if (
        !new RegExp(`^\\s*pg_catalog\\.lower\\(\\s*${identifier}\\s*\\)\\s*$`, 'iu').test(
          expression,
        )
      )
        return true;
    }
  }
  return false;
}

function hasUnprovenAlterFunction(value) {
  return operationSlices(value, 'ALTER').some(
    (statement) =>
      /\bDEFAULT\b[\s\S]*(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*|"(?:""|[^"])+")\s*\(/iu.test(
        statement,
      ) ||
      /\bCHECK\s*\([\s\S]*(?:(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_$]|[^\x00-\x7F])*|"(?:""|[^"])+")\s*\(/iu.test(
        statement,
      ),
  );
}

function hasUnprovenAddConstraint(value) {
  // Reject explicit and shorthand constraints, including future PostgreSQL constraint forms.
  return operationSlices(value, 'ALTER').some((statement) =>
    ADD_TABLE_CONSTRAINT_PATTERN.test(statement),
  );
}

function isProvenSafeAlterColumnType(value) {
  const builtinType =
    '(?:smallint|int2|integer|int|int4|bigint|int8|decimal|numeric|real|float4|double\\s+precision|float8|money|character|char|character\\s+varying|varchar|text|bytea|timestamp(?:\\s+(?:with|without)\\s+time\\s+zone)?|timestamptz|date|time(?:\\s+(?:with|without)\\s+time\\s+zone)?|timetz|interval|boolean|bool|point|line|lseg|box|path|polygon|circle|cidr|inet|macaddr|macaddr8|bit|bit\\s+varying|varbit|tsvector|tsquery|uuid|xml|json|jsonb|name|oid|pg_lsn)';
  const modifier = '(?:\\s*\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?';
  const arrays = '(?:\\s*\\[\\s*\\])*';
  if (/^\s*(?:smallserial|serial2|serial|serial4|bigserial|serial8)\b/iu.test(value)) return false;
  return new RegExp(
    `^\\s*(?:pg_catalog\\s*\\.\\s*)?${builtinType}${modifier}${arrays}\\s*$`,
    'iu',
  ).test(value);
}

function isProvenStaticAlterDefault(value) {
  const literal = value.trim();
  if (/^(?:NULL|TRUE|FALSE)$/iu.test(literal)) return true;
  if (/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(literal)) return true;
  if (/^(?:E)?'(?:''|\\[\s\S]|[^'])*'$/iu.test(literal)) return true;
  const tag = dollarQuoteTagAt(literal, 0);
  return (
    tag !== null &&
    literal.endsWith(tag) &&
    literal.indexOf(tag, tag.length) === literal.length - tag.length
  );
}

function isProvenSafeAddColumn(statement) {
  const identifier =
    '(?:(?:[A-Za-z_]|[^\\x00-\\x7F])(?:[A-Za-z0-9_$]|[^\\x00-\\x7F])*|"(?:""|[^"])+")';
  const match = statement.match(
    new RegExp(
      `^ALTER\\s+TABLE\\s+\\S+\\s+ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+([\\s\\S]+)$`,
      'iu',
    ),
  );
  if (!match) return false;
  const definition = match[1].trim();
  const defaultMatch = definition.match(/^([\s\S]*?)\s+DEFAULT\s+([\s\S]+)$/iu);
  if (!defaultMatch) return isProvenSafeAlterColumnType(definition);
  return (
    isProvenSafeAlterColumnType(defaultMatch[1]) && isProvenStaticAlterDefault(defaultMatch[2])
  );
}

// A proven nullable ADD COLUMN uses a built-in type plus an optional static literal.
function hasRiskyAddColumn(value) {
  return operationSlices(value, 'ALTER').some((statement) => {
    if (ADD_TABLE_CONSTRAINT_PATTERN.test(statement)) return false;
    if (!/^ALTER\s+TABLE\s+\S+\s+ADD\s+/iu.test(statement)) return false;
    return !isProvenSafeAddColumn(statement);
  });
}

function changedLines(diff, prefix, header) {
  return diff
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(header))
    .map((line) => line.slice(1))
    .join('\n');
}

function addedTargetLines(diff) {
  const lines = new Set();
  let targetLine = null;
  for (const line of diff.split(/\r?\n/u)) {
    const hunk = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
    if (hunk) {
      targetLine = Number(hunk[1]);
      continue;
    }
    if (targetLine === null || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      lines.add(targetLine);
      targetLine += 1;
    } else if (!line.startsWith('-')) targetLine += 1;
  }
  return lines;
}

function touchesAddedLine(sourceFile, node, addedLines) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
  for (let line = start; line <= end; line += 1) {
    if (addedLines.has(line)) return true;
  }
  return false;
}

function isStaticSqlLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isStaticDataExpression(node) {
  if (
    isStaticSqlLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return isStaticDataExpression(node.expression);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) => !ts.isSpreadElement(element) && isStaticDataExpression(element),
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isStaticDataExpression(property.initializer),
    );
  return false;
}

function isAllowedDeclarativeStatement(node) {
  if (!ts.isVariableStatement(node)) return false;
  if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  if ((node.modifiers ?? []).some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword))
    return false;
  return node.declarationList.declarations.every(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      isStaticDataExpression(declaration.initializer),
  );
}

function analyzeScriptMigration(content, diff, path) {
  const analysis = { unsafe: false, staticLiterals: [] };
  if (!SCRIPT_MIGRATION_PATTERN.test(path)) return analysis;
  const addedLines = addedTargetLines(diff);
  if (addedLines.size === 0) return analysis;

  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    analysis.unsafe = true;
    return analysis;
  }

  const touchedStatements = sourceFile.statements.filter((statement) =>
    touchesAddedLine(sourceFile, statement, addedLines),
  );
  if (touchedStatements.some((statement) => !isAllowedDeclarativeStatement(statement))) {
    analysis.unsafe = true;
    return analysis;
  }

  const collectLiterals = (node) => {
    if (touchesAddedLine(sourceFile, node, addedLines) && isStaticSqlLiteral(node))
      analysis.staticLiterals.push(node.text);
    ts.forEachChild(node, collectLiterals);
  };
  for (const statement of touchedStatements) collectLiterals(statement);
  return analysis;
}

function relativeModuleDependencies(content, path, requestedBindings, requestedCallableBindings) {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0)
    throw new Error(`Migration dependency ${path} is not valid TypeScript`);

  const calledIdentifiers = new Set();
  const calledMemberBindings = new Map();
  const collectCallTargetIdentifiers = (node) => {
    if (ts.isIdentifier(node)) calledIdentifiers.add(node.text);
    ts.forEachChild(node, collectCallTargetIdentifiers);
  };
  const unwrapExpression = (node) => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    )
      current = current.expression;
    return current;
  };
  const staticMemberKey = (node) => {
    const current = unwrapExpression(node);
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isNumericLiteral(current)
    )
      return current.text;
    return '*';
  };
  const reflectObjectAliases = new Set(['Reflect']);
  const objectConstructorAliases = new Set(['Object']);
  const reflectGetAliases = new Set();
  const reflectDescriptorAliases = new Set();
  const objectDescriptorAliases = new Set();
  const objectDescriptorsAliases = new Set();
  const descriptorCallableFields = new Set(['value', 'get', 'set']);
  // Method aliases may be identifiers or statically named one-level object members.
  const staticReferenceKey = (node) => {
    const expression = unwrapExpression(node);
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
      return `${expression.expression.text}.${expression.name.text}`;
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.argumentExpression
    )
      return `${expression.expression.text}.${staticMemberKey(expression.argumentExpression)}`;
    return undefined;
  };
  const isFunctionPrototypeMethod = (node, method) => {
    const expression = unwrapExpression(node);
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== method) return false;
    const prototype = unwrapExpression(expression.expression);
    return (
      ts.isPropertyAccessExpression(prototype) &&
      ts.isIdentifier(prototype.expression) &&
      prototype.expression.text === 'Function' &&
      prototype.name.text === 'prototype'
    );
  };
  const isMethodReference = (node, objectAliases, methodAliases, method) => {
    const expression = unwrapExpression(node);
    const referenceKey = staticReferenceKey(expression);
    if (referenceKey && methodAliases.has(referenceKey)) return true;
    if (ts.isCallExpression(expression)) {
      const callee = unwrapExpression(expression.expression);
      const invocation =
        ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
          ? ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : callee.argumentExpression
              ? staticMemberKey(callee.argumentExpression)
              : '*'
          : undefined;
      if (invocation === 'bind') {
        if (isMethodReference(callee.expression, objectAliases, methodAliases, method)) return true;
        if (
          isFunctionPrototypeMethod(callee.expression, 'call') &&
          expression.arguments[0] &&
          isMethodReference(expression.arguments[0], objectAliases, methodAliases, method)
        )
          return true;
      }
    }
    if (ts.isPropertyAccessExpression(expression))
      return (
        ts.isIdentifier(expression.expression) &&
        objectAliases.has(expression.expression.text) &&
        expression.name.text === method
      );
    if (ts.isElementAccessExpression(expression))
      return (
        ts.isIdentifier(expression.expression) &&
        objectAliases.has(expression.expression.text) &&
        expression.argumentExpression &&
        staticMemberKey(expression.argumentExpression) === method
      );
    return false;
  };
  let reflectiveAliasesChanged = true;
  while (reflectiveAliasesChanged) {
    reflectiveAliasesChanged = false;
    const addAlias = (aliases, name) => {
      if (!aliases.has(name)) {
        aliases.add(name);
        reflectiveAliasesChanged = true;
      }
    };
    const addDestructuredMethodAlias = (owner, propertyName, localName) => {
      if (reflectObjectAliases.has(owner) && propertyName === 'get')
        addAlias(reflectGetAliases, localName);
      if (reflectObjectAliases.has(owner) && propertyName === 'getOwnPropertyDescriptor')
        addAlias(reflectDescriptorAliases, localName);
      if (objectConstructorAliases.has(owner) && propertyName === 'getOwnPropertyDescriptor')
        addAlias(objectDescriptorAliases, localName);
      if (objectConstructorAliases.has(owner) && propertyName === 'getOwnPropertyDescriptors')
        addAlias(objectDescriptorsAliases, localName);
    };
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isIdentifier(initializer)) {
          if (reflectObjectAliases.has(initializer.text))
            addAlias(reflectObjectAliases, node.name.text);
          if (objectConstructorAliases.has(initializer.text))
            addAlias(objectConstructorAliases, node.name.text);
        }
        if (isMethodReference(initializer, reflectObjectAliases, reflectGetAliases, 'get'))
          addAlias(reflectGetAliases, node.name.text);
        if (
          isMethodReference(
            initializer,
            reflectObjectAliases,
            reflectDescriptorAliases,
            'getOwnPropertyDescriptor',
          )
        )
          addAlias(reflectDescriptorAliases, node.name.text);
        if (
          isMethodReference(
            initializer,
            objectConstructorAliases,
            objectDescriptorAliases,
            'getOwnPropertyDescriptor',
          )
        )
          addAlias(objectDescriptorAliases, node.name.text);
        if (
          isMethodReference(
            initializer,
            objectConstructorAliases,
            objectDescriptorsAliases,
            'getOwnPropertyDescriptors',
          )
        )
          addAlias(objectDescriptorsAliases, node.name.text);
        if (ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const propertyName =
              ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name) ||
              ts.isNumericLiteral(property.name)
                ? property.name.text
                : undefined;
            if (!propertyName) continue;
            const alias = `${node.name.text}.${propertyName}`;
            const target = unwrapExpression(property.initializer);
            if (isMethodReference(target, reflectObjectAliases, reflectGetAliases, 'get'))
              addAlias(reflectGetAliases, alias);
            if (
              isMethodReference(
                target,
                reflectObjectAliases,
                reflectDescriptorAliases,
                'getOwnPropertyDescriptor',
              )
            )
              addAlias(reflectDescriptorAliases, alias);
            if (
              isMethodReference(
                target,
                objectConstructorAliases,
                objectDescriptorAliases,
                'getOwnPropertyDescriptor',
              )
            )
              addAlias(objectDescriptorAliases, alias);
            if (
              isMethodReference(
                target,
                objectConstructorAliases,
                objectDescriptorsAliases,
                'getOwnPropertyDescriptors',
              )
            )
              addAlias(objectDescriptorsAliases, alias);
          }
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(unwrapExpression(node.initializer))
      ) {
        const owner = unwrapExpression(node.initializer).text;
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const property = element.propertyName ?? element.name;
          const propertyName =
            ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
          addDestructuredMethodAlias(owner, propertyName, element.name.text);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(node.left);
        const right = unwrapExpression(node.right);
        if (ts.isIdentifier(left)) {
          if (ts.isIdentifier(right)) {
            if (reflectObjectAliases.has(right.text)) addAlias(reflectObjectAliases, left.text);
            if (objectConstructorAliases.has(right.text))
              addAlias(objectConstructorAliases, left.text);
          }
          if (isMethodReference(right, reflectObjectAliases, reflectGetAliases, 'get'))
            addAlias(reflectGetAliases, left.text);
          if (
            isMethodReference(
              right,
              reflectObjectAliases,
              reflectDescriptorAliases,
              'getOwnPropertyDescriptor',
            )
          )
            addAlias(reflectDescriptorAliases, left.text);
          if (
            isMethodReference(
              right,
              objectConstructorAliases,
              objectDescriptorAliases,
              'getOwnPropertyDescriptor',
            )
          )
            addAlias(objectDescriptorAliases, left.text);
          if (
            isMethodReference(
              right,
              objectConstructorAliases,
              objectDescriptorsAliases,
              'getOwnPropertyDescriptors',
            )
          )
            addAlias(objectDescriptorsAliases, left.text);
        }
        const assignedAlias = staticReferenceKey(left);
        if (assignedAlias && !ts.isIdentifier(left)) {
          if (isMethodReference(right, reflectObjectAliases, reflectGetAliases, 'get'))
            addAlias(reflectGetAliases, assignedAlias);
          if (
            isMethodReference(
              right,
              reflectObjectAliases,
              reflectDescriptorAliases,
              'getOwnPropertyDescriptor',
            )
          )
            addAlias(reflectDescriptorAliases, assignedAlias);
          if (
            isMethodReference(
              right,
              objectConstructorAliases,
              objectDescriptorAliases,
              'getOwnPropertyDescriptor',
            )
          )
            addAlias(objectDescriptorAliases, assignedAlias);
          if (
            isMethodReference(
              right,
              objectConstructorAliases,
              objectDescriptorsAliases,
              'getOwnPropertyDescriptors',
            )
          )
            addAlias(objectDescriptorsAliases, assignedAlias);
        }
        if (ts.isObjectLiteralExpression(left) && ts.isIdentifier(right)) {
          for (const property of left.properties) {
            const propertyName =
              property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
                ? property.name.text
                : undefined;
            const target = ts.isShorthandPropertyAssignment(property)
              ? property.name
              : ts.isPropertyAssignment(property)
                ? unwrapExpression(property.initializer)
                : undefined;
            if (propertyName && target && ts.isIdentifier(target))
              addDestructuredMethodAlias(right.text, propertyName, target.text);
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sourceFile);
  }
  const methodCallArguments = (node, owner, method) => {
    if (!ts.isCallExpression(node)) return undefined;
    const objectAliases = owner === 'Reflect' ? reflectObjectAliases : objectConstructorAliases;
    const methodAliases =
      owner === 'Reflect'
        ? method === 'get'
          ? reflectGetAliases
          : reflectDescriptorAliases
        : method === 'getOwnPropertyDescriptors'
          ? objectDescriptorsAliases
          : objectDescriptorAliases;
    if (isMethodReference(node.expression, objectAliases, methodAliases, method))
      return [...node.arguments];
    const callee = unwrapExpression(node.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))
      return undefined;
    const invocation = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : callee.argumentExpression
        ? staticMemberKey(callee.argumentExpression)
        : '*';
    if (
      !['call', 'apply'].includes(invocation) ||
      !isMethodReference(callee.expression, objectAliases, methodAliases, method)
    )
      return undefined;
    if (invocation === 'call') return [...node.arguments].slice(1);
    const appliedArguments = node.arguments[1] && unwrapExpression(node.arguments[1]);
    if (
      !appliedArguments ||
      !ts.isArrayLiteralExpression(appliedArguments) ||
      appliedArguments.elements.some(ts.isSpreadElement)
    )
      // A dynamic apply array can hide both the imported owner and selected member.
      throw new Error(`${owner}.${method}.apply arguments cannot be proven statically`);
    return [...appliedArguments.elements];
  };
  const isMethodCall = (node, owner, method) =>
    methodCallArguments(node, owner, method) !== undefined;
  // A local zero-side-effect wrapper does not erase the descriptor container's source object.
  const descriptorContainerFactories = new Map();
  const registerDescriptorContainerFactory = (name, parameters, body) => {
    let returned;
    if (!ts.isBlock(body)) returned = unwrapExpression(body);
    else {
      const returns = [];
      const collectReturns = (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
          returns.push(unwrapExpression(node.expression));
          return;
        }
        if (!ts.isFunctionLike(node) || node === body) ts.forEachChild(node, collectReturns);
      };
      collectReturns(body);
      if (returns.length === 1) returned = returns[0];
    }
    if (!returned || !isMethodCall(returned, 'Object', 'getOwnPropertyDescriptors')) return;
    const [target] = methodCallArguments(returned, 'Object', 'getOwnPropertyDescriptors');
    if (!target) return;
    descriptorContainerFactories.set(name, {
      parameters: parameters.map((parameter) =>
        ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
      ),
      target,
    });
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      registerDescriptorContainerFactory(statement.name.text, statement.parameters, statement.body);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      )
        registerDescriptorContainerFactory(
          declaration.name.text,
          declaration.initializer.parameters,
          declaration.initializer.body,
        );
    }
  }
  const descriptorContainerTarget = (node) => {
    const current = unwrapExpression(node);
    if (isMethodCall(current, 'Object', 'getOwnPropertyDescriptors'))
      return methodCallArguments(current, 'Object', 'getOwnPropertyDescriptors')?.[0];
    if (!ts.isCallExpression(current) || !ts.isIdentifier(current.expression)) return undefined;
    const factory = descriptorContainerFactories.get(current.expression.text);
    if (!factory) return undefined;
    const target = unwrapExpression(factory.target);
    if (!ts.isIdentifier(target)) return target;
    const parameterIndex = factory.parameters.indexOf(target.text);
    return parameterIndex >= 0 ? current.arguments[parameterIndex] : target;
  };
  const appendMember = (reference, member) => {
    if (!reference) return undefined;
    if (reference.members.includes('*') || member === '*')
      return { owner: reference.owner, members: ['*'] };
    return { owner: reference.owner, members: [...reference.members, member] };
  };
  let descriptorMemberReference;
  const objectReference = (node) => {
    const current = unwrapExpression(node);
    if (ts.isIdentifier(current)) return { owner: current.text, members: [] };
    if (isMethodCall(current, 'Reflect', 'get')) {
      const [target, key] = methodCallArguments(current, 'Reflect', 'get');
      if (!target || !key) return undefined;
      const member = staticMemberKey(key);
      if (descriptorCallableFields.has(member) || member === '*') {
        const descriptorReference = descriptorMemberReference(target);
        if (descriptorReference) return descriptorReference;
      }
      return appendMember(objectReference(target), member);
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const member = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : current.argumentExpression
          ? staticMemberKey(current.argumentExpression)
          : '*';
      const expression = unwrapExpression(current.expression);
      if (descriptorCallableFields.has(member) || member === '*') {
        const descriptorReference = descriptorMemberReference(expression);
        if (descriptorReference) return descriptorReference;
      }
      return appendMember(objectReference(expression), member);
    }
    return undefined;
  };
  descriptorMemberReference = (node) => {
    const current = unwrapExpression(node);
    for (const owner of ['Reflect', 'Object']) {
      if (!isMethodCall(current, owner, 'getOwnPropertyDescriptor')) continue;
      const [target, key] = methodCallArguments(current, owner, 'getOwnPropertyDescriptor');
      if (!target || !key) return undefined;
      return appendMember(objectReference(target), staticMemberKey(key));
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const key = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : current.argumentExpression
          ? staticMemberKey(current.argumentExpression)
          : '*';
      const container = unwrapExpression(current.expression);
      const target = descriptorContainerTarget(container);
      if (target) return appendMember(objectReference(target), key);
    }
    return undefined;
  };
  const descriptorContainerReference = (node) => {
    const target = descriptorContainerTarget(node);
    return target ? objectReference(target) : undefined;
  };
  const memberReference = (node) => {
    const reference = objectReference(node);
    if (!reference || reference.members.length === 0) return undefined;
    return { owner: reference.owner, member: reference.members.join('.') };
  };
  const addCalledMember = (owner, member) => {
    const members = calledMemberBindings.get(owner) ?? new Set();
    if (members.has(member)) return false;
    members.add(member);
    calledMemberBindings.set(owner, members);
    return true;
  };
  const markCallableMember = (node) => {
    const reference = memberReference(node);
    if (!reference) return;
    addCalledMember(reference.owner, reference.member);
    const members = reference.member.split('.');
    if (['call', 'apply', 'bind'].includes(members.at(-1)) && members.length > 1)
      addCalledMember(reference.owner, members.slice(0, -1).join('.'));
  };
  const isCalledReference = (node) => {
    if (ts.isIdentifier(node)) return calledIdentifiers.has(node.text);
    const reference = memberReference(node);
    return (
      reference !== undefined &&
      calledMemberBindings.get(reference.owner)?.has(reference.member) === true
    );
  };
  const callbackMethodArguments = new Map([
    ['map', [0]],
    ['flatMap', [0]],
    ['forEach', [0]],
    ['filter', [0]],
    ['some', [0]],
    ['every', [0]],
    ['find', [0]],
    ['findIndex', [0]],
    ['findLast', [0]],
    ['findLastIndex', [0]],
    ['reduce', [0]],
    ['reduceRight', [0]],
    ['sort', [0]],
    ['then', [0, 1]],
    ['catch', [0]],
    ['finally', [0]],
    ['from', [1]],
    ['replace', [1]],
    ['replaceAll', [1]],
  ]);
  const callbackFunctionArguments = new Map([
    ['setTimeout', [0]],
    ['setInterval', [0]],
    ['setImmediate', [0]],
    ['queueMicrotask', [0]],
  ]);
  // Unknown higher-order APIs are fail-closed, including callable arguments nested in containers.
  const callbackArgumentIndexes = (node) => {
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Promise') return [0];
      return node.arguments?.map((_, index) => index) ?? [];
    }
    if (!ts.isCallExpression(node)) return [];
    if (
      isMethodCall(node, 'Reflect', 'get') ||
      isMethodCall(node, 'Reflect', 'getOwnPropertyDescriptor') ||
      isMethodCall(node, 'Object', 'getOwnPropertyDescriptor') ||
      isMethodCall(node, 'Object', 'getOwnPropertyDescriptors')
    )
      return [];
    if (ts.isIdentifier(node.expression))
      return (
        callbackFunctionArguments.get(node.expression.text) ??
        node.arguments.map((_, index) => index)
      );
    if (ts.isPropertyAccessExpression(node.expression))
      return (
        callbackMethodArguments.get(node.expression.name.text) ??
        node.arguments.map((_, index) => index)
      );
    if (
      ts.isElementAccessExpression(node.expression) &&
      node.expression.argumentExpression &&
      ts.isStringLiteral(node.expression.argumentExpression)
    )
      return (
        callbackMethodArguments.get(node.expression.argumentExpression.text) ??
        node.arguments.map((_, index) => index)
      );
    return node.arguments.map((_, index) => index);
  };
  const collectCallableReference = (node) => {
    if (ts.isIdentifier(node)) {
      calledIdentifiers.add(node.text);
      return;
    }
    if (memberReference(node)) {
      collectCallTargetIdentifiers(node);
      markCallableMember(node);
      return;
    }
    if (ts.isSpreadElement(node)) {
      collectCallableReference(node.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectCallableReference(element);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      // Recurse through values while avoiding ordinary non-callable data imports.
      for (const property of node.properties) {
        if (property.name && ts.isComputedPropertyName(property.name))
          collectCallableReference(property.name.expression);
        if (ts.isPropertyAssignment(property)) collectCallableReference(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) {
          collectCallableReference(property.name);
          if (property.objectAssignmentInitializer)
            collectCallableReference(property.objectAssignmentInitializer);
        } else if (ts.isSpreadAssignment(property)) collectCallableReference(property.expression);
        else collectCallTargetIdentifiers(property);
      }
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      collectCallTargetIdentifiers(node.body);
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      collectCallableReference(node.expression);
      return;
    }
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      collectCallableReference(node.expression);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collectCallableReference(node.whenTrue);
      collectCallableReference(node.whenFalse);
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.CommaToken,
      ].includes(node.operatorToken.kind)
    ) {
      collectCallableReference(node.left);
      collectCallableReference(node.right);
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      collectCallTargetIdentifiers(node);
      markCallableMember(node);
    }
  };
  const visitCalls = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      collectCallTargetIdentifiers(node.expression);
      markCallableMember(node.expression);
      for (const index of callbackArgumentIndexes(node)) {
        const argument = node.arguments?.[index];
        if (argument) collectCallableReference(argument);
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      collectCallTargetIdentifiers(node.tag);
      markCallableMember(node.tag);
    }
    ts.forEachChild(node, visitCalls);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      visitCalls(statement);
  }

  const propertyNameText = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
      return name.expression.text;
    return undefined;
  };
  let calledAliasesChanged = true;
  while (calledAliasesChanged) {
    calledAliasesChanged = false;
    const collectAliasSources = (node) => {
      const reference = memberReference(node);
      if (reference) {
        if (addCalledMember(reference.owner, reference.member)) calledAliasesChanged = true;
        return;
      }
      if (ts.isIdentifier(node) && !calledIdentifiers.has(node.text)) {
        calledIdentifiers.add(node.text);
        calledAliasesChanged = true;
      }
      ts.forEachChild(node, collectAliasSources);
    };
    const propagateMembers = (initializer, members) => {
      const descriptorReference = descriptorMemberReference(initializer);
      if (
        descriptorReference &&
        [...members].some((member) => {
          const field = member.split('.')[0];
          return field === '*' || descriptorCallableFields.has(field);
        })
      ) {
        if (addCalledMember(descriptorReference.owner, descriptorReference.members.join('.')))
          calledAliasesChanged = true;
        return;
      }
      const descriptorContainer = descriptorContainerReference(initializer);
      if (descriptorContainer) {
        for (const member of members) {
          const segments = member.split('.');
          if (
            segments.length < 2 ||
            (segments[1] !== '*' && !descriptorCallableFields.has(segments[1]))
          )
            continue;
          const mapped = appendMember(descriptorContainer, segments[0]);
          const callable = segments.slice(2).reduce(appendMember, mapped);
          if (callable && addCalledMember(callable.owner, callable.members.join('.')))
            calledAliasesChanged = true;
        }
        return;
      }
      if (ts.isIdentifier(initializer)) {
        for (const member of members)
          if (addCalledMember(initializer.text, member)) calledAliasesChanged = true;
        return;
      }
      const reference = memberReference(initializer);
      if (reference)
        for (const member of members)
          if (addCalledMember(reference.owner, `${reference.member}.${member}`))
            calledAliasesChanged = true;
    };
    const collectDestructuredMembers = (node, prefix = [], output = []) => {
      if (ts.isIdentifier(node)) {
        if (calledIdentifiers.has(node.text) && prefix.length > 0) output.push(prefix.join('.'));
        return output;
      }
      if (ts.isObjectBindingPattern(node)) {
        for (const element of node.elements) {
          const member = propertyNameText(element.propertyName ?? element.name);
          collectDestructuredMembers(element.name, member ? [...prefix, member] : ['*'], output);
        }
        return output;
      }
      if (ts.isArrayBindingPattern(node)) {
        node.elements.forEach((element, index) => {
          if (ts.isBindingElement(element))
            collectDestructuredMembers(element.name, [...prefix, String(index)], output);
        });
        return output;
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isShorthandPropertyAssignment(property))
            collectDestructuredMembers(property.name, [...prefix, property.name.text], output);
          else if (ts.isPropertyAssignment(property)) {
            const member = propertyNameText(property.name);
            collectDestructuredMembers(
              property.initializer,
              member ? [...prefix, member] : ['*'],
              output,
            );
          }
        }
      }
      return output;
    };
    const visitAliases = (node) => {
      // Static field aliases are executable when their class member is invoked.
      if (ts.isClassDeclaration(node) && node.name) {
        const calledMembers = calledMemberBindings.get(node.name.text);
        if (calledMembers)
          for (const member of node.members) {
            if (!member.name) continue;
            const memberName = propertyNameText(member.name);
            if (
              calledMembers.has('*') ||
              (memberName &&
                [...calledMembers].some(
                  (calledMember) =>
                    calledMember === memberName || calledMember.startsWith(`${memberName}.`),
                ))
            ) {
              if (ts.isPropertyDeclaration(member) && member.initializer)
                collectAliasSources(member.initializer);
              else collectAliasSources(member);
            }
          }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) {
          const members = calledMemberBindings.get(node.name.text);
          if (members) propagateMembers(node.initializer, members);
        } else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
          const members = collectDestructuredMembers(node.name);
          if (members.length > 0) propagateMembers(node.initializer, members);
        }
        let bindingIsCalled = false;
        const visitBinding = (binding) => {
          if (ts.isIdentifier(binding) && calledIdentifiers.has(binding.text))
            bindingIsCalled = true;
          ts.forEachChild(binding, visitBinding);
        };
        visitBinding(node.name);
        if (bindingIsCalled) collectAliasSources(node.initializer);
      }
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.AmpersandAmpersandEqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        if (ts.isIdentifier(node.left)) {
          const members = calledMemberBindings.get(node.left.text);
          if (members) propagateMembers(node.right, members);
        } else {
          const members = collectDestructuredMembers(node.left);
          if (members.length > 0) propagateMembers(node.right, members);
        }
        if (isCalledReference(node.left)) collectAliasSources(node.right);
        else if (ts.isIdentifier(node.left) && calledIdentifiers.has(node.left.text))
          collectAliasSources(node.right);
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }

  // Keep class and object member-qualified callable requests intact until import resolution.
  const callableLocalBindings = new Set(requestedCallableBindings);
  let callableAliasesChanged = true;
  while (callableAliasesChanged) {
    callableAliasesChanged = false;
    for (const statement of sourceFile.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.moduleSpecifier ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        continue;
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        const localName = (element.propertyName ?? element.name).text;
        for (const binding of [...callableLocalBindings]) {
          if (binding !== exportedName && !binding.startsWith(`${exportedName}.`)) continue;
          const localBinding = `${localName}${binding.slice(exportedName.length)}`;
          if (!callableLocalBindings.has(localBinding)) {
            callableLocalBindings.add(localBinding);
            callableAliasesChanged = true;
          }
        }
      }
    }
  }

  let callableMemberPropagationChanged = true;
  while (callableMemberPropagationChanged) {
    callableMemberPropagationChanged = false;
    const addCallableBinding = (binding) => {
      if (!callableLocalBindings.has(binding)) {
        callableLocalBindings.add(binding);
        callableMemberPropagationChanged = true;
      }
    };
    const visitedFactories = new Set();
    const collectRequestedMember = (initializer, members) => {
      if (!initializer) return;
      if (
        ts.isParenthesizedExpression(initializer) ||
        ts.isAsExpression(initializer) ||
        ts.isTypeAssertionExpression(initializer) ||
        ts.isNonNullExpression(initializer) ||
        ts.isSatisfiesExpression(initializer)
      ) {
        collectRequestedMember(initializer.expression, members);
        return;
      }
      if (members.length === 0) {
        collectCallableReference(initializer);
        return;
      }
      if (ts.isIdentifier(initializer)) {
        addCallableBinding(`${initializer.text}.${members.join('.')}`);
        return;
      }
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        const factoryName = initializer.expression.text;
        const visitKey = `${factoryName}.${members.join('.')}`;
        if (!visitedFactories.has(visitKey)) {
          visitedFactories.add(visitKey);
          const collectReturns = (node) => {
            if (ts.isReturnStatement(node) && node.expression) {
              collectRequestedMember(node.expression, members);
              return;
            }
            ts.forEachChild(node, collectReturns);
          };
          for (const statement of sourceFile.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName)
              collectReturns(statement.body);
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
              if (
                !ts.isIdentifier(declaration.name) ||
                declaration.name.text !== factoryName ||
                !declaration.initializer ||
                (!ts.isArrowFunction(declaration.initializer) &&
                  !ts.isFunctionExpression(declaration.initializer))
              )
                continue;
              if (ts.isBlock(declaration.initializer.body))
                collectReturns(declaration.initializer.body);
              else collectRequestedMember(declaration.initializer.body, members);
            }
          }
        }
        for (const argument of initializer.arguments) collectCallableReference(argument);
        return;
      }
      if (ts.isObjectLiteralExpression(initializer)) {
        const [member, ...remaining] = members;
        for (const property of initializer.properties) {
          if (member === '*') {
            if (ts.isSpreadAssignment(property))
              collectRequestedMember(property.expression, members);
            else if (ts.isPropertyAssignment(property))
              collectRequestedMember(property.initializer, []);
            else if (ts.isShorthandPropertyAssignment(property))
              collectRequestedMember(property.name, []);
            else collectCallTargetIdentifiers(property);
            continue;
          }
          if (ts.isSpreadAssignment(property)) {
            collectRequestedMember(property.expression, members);
            continue;
          }
          const propertyName = property.name && propertyNameText(property.name);
          if (propertyName !== member) continue;
          if (ts.isPropertyAssignment(property))
            collectRequestedMember(property.initializer, remaining);
          else if (ts.isShorthandPropertyAssignment(property))
            collectRequestedMember(property.name, remaining);
          else collectCallTargetIdentifiers(property);
        }
        return;
      }
      collectCallableReference(initializer);
    };
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals)
        for (const binding of [...callableLocalBindings])
          if (binding.startsWith('default.'))
            collectRequestedMember(
              statement.expression,
              binding.slice('default.'.length).split('.'),
            );
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const prefix = `${declaration.name.text}.`;
        for (const binding of [...callableLocalBindings]) {
          if (binding.startsWith(prefix))
            collectRequestedMember(
              declaration.initializer,
              binding.slice(prefix.length).split('.'),
            );
        }
      }
    }
  }

  const dependencies = [];
  const requestedAll = requestedBindings.has('*');
  const requestedCallableAll = requestedCallableBindings.has('*');
  // Callable member paths and direct calls are preserved independently through imports.
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      RELATIVE_MODULE_SPECIFIER.test(statement.moduleSpecifier.text)
    ) {
      const bindings = new Set();
      const callableBindings = new Set();
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (!clause) bindings.add('*');
      else {
        if (clause.name) {
          bindings.add('default');
          const calledMembers = calledMemberBindings.get(clause.name.text);
          const callableMembers = [...callableLocalBindings]
            .filter((binding) => binding.startsWith(`${clause.name.text}.`))
            .map((binding) => binding.slice(clause.name.text.length + 1));
          if (calledMembers) for (const member of calledMembers) callableMembers.push(member);
          if (requestedCallableAll) callableBindings.add('default');
          else {
            for (const member of callableMembers) callableBindings.add(`default.${member}`);
            if (
              calledIdentifiers.has(clause.name.text) ||
              callableLocalBindings.has(clause.name.text)
            )
              callableBindings.add('default');
          }
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.add('*');
            const localName = clause.namedBindings.name.text;
            const calledMembers = calledMemberBindings.get(localName);
            const callableMembers = [...callableLocalBindings]
              .filter((binding) => binding.startsWith(`${localName}.`))
              .map((binding) => binding.slice(localName.length + 1));
            if (calledMembers) for (const member of calledMembers) callableMembers.push(member);
            for (const member of callableMembers) callableBindings.add(member);
            if (
              requestedCallableAll ||
              callableLocalBindings.has(localName) ||
              (calledIdentifiers.has(localName) && callableMembers.length === 0)
            )
              callableBindings.add('*');
          } else {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              const importedName = (element.propertyName ?? element.name).text;
              const localName = element.name.text;
              bindings.add(importedName);
              const calledMembers = calledMemberBindings.get(localName);
              const callableMembers = [...callableLocalBindings]
                .filter((binding) => binding.startsWith(`${localName}.`))
                .map((binding) => binding.slice(localName.length + 1));
              if (calledMembers) for (const member of calledMembers) callableMembers.push(member);
              if (requestedCallableAll) callableBindings.add(importedName);
              else {
                for (const member of callableMembers)
                  callableBindings.add(`${importedName}.${member}`);
                if (calledIdentifiers.has(localName) || callableLocalBindings.has(localName))
                  callableBindings.add(importedName);
              }
            }
          }
        }
      }
      const sideEffect =
        !clause ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            (clause.namedBindings !== undefined &&
              (ts.isNamespaceImport(clause.namedBindings) ||
                clause.namedBindings.elements.length === 0 ||
                clause.namedBindings.elements.some((element) => !element.isTypeOnly)))));
      if (bindings.size > 0 || sideEffect)
        dependencies.push({
          specifier: statement.moduleSpecifier.text,
          bindings,
          callableBindings,
          sideEffect,
        });
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      RELATIVE_MODULE_SPECIFIER.test(statement.moduleSpecifier.text)
    ) {
      if (statement.isTypeOnly) continue;
      const bindings = new Set();
      const callableBindings = new Set();
      if (!statement.exportClause) {
        for (const binding of requestedBindings) bindings.add(binding);
        for (const binding of requestedCallableBindings) callableBindings.add(binding);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (requestedAll || requestedBindings.has(statement.exportClause.name.text))
          bindings.add('*');
        if (
          requestedCallableAll ||
          [...requestedCallableBindings].some(
            (binding) =>
              binding === statement.exportClause.name.text ||
              binding.startsWith(`${statement.exportClause.name.text}.`),
          )
        )
          callableBindings.add('*');
      } else {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          if (requestedAll || requestedBindings.has(element.name.text))
            bindings.add((element.propertyName ?? element.name).text);
          if (requestedCallableAll)
            callableBindings.add((element.propertyName ?? element.name).text);
          else
            for (const binding of requestedCallableBindings) {
              if (binding === element.name.text || binding.startsWith(`${element.name.text}.`))
                callableBindings.add(
                  `${(element.propertyName ?? element.name).text}${binding.slice(element.name.text.length)}`,
                );
            }
        }
      }
      const sideEffect =
        !statement.isTypeOnly &&
        (statement.exportClause === undefined ||
          ts.isNamespaceExport(statement.exportClause) ||
          statement.exportClause.elements.length === 0 ||
          statement.exportClause.elements.some((element) => !element.isTypeOnly));
      if (bindings.size > 0 || sideEffect)
        dependencies.push({
          specifier: statement.moduleSpecifier.text,
          bindings,
          callableBindings,
          sideEffect,
        });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression) &&
      RELATIVE_MODULE_SPECIFIER.test(statement.moduleReference.expression.text)
    )
      dependencies.push({
        specifier: statement.moduleReference.expression.text,
        bindings: new Set(['*']),
        callableBindings: calledIdentifiers.has(statement.name.text) ? new Set(['*']) : new Set(),
        sideEffect: true,
      });
  }
  return dependencies;
}

function hasUnprovenRuntimeModuleLoad(content, path) {
  if (!SCRIPT_MIGRATION_PATTERN.test(path)) return false;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0)
    throw new Error(`Migration dependency ${path} is not valid TypeScript`);

  const factoryNames = new Set(['createRequire']);
  const factoryNamespaceNames = new Set();
  const loaderNames = new Set(['require']);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['module', 'node:module'].includes(statement.moduleSpecifier.text) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    )
      continue;
    const runtimeCreateRequireImport =
      statement.importClause.name !== undefined ||
      (statement.importClause.namedBindings !== undefined &&
        (ts.isNamespaceImport(statement.importClause.namedBindings) ||
          statement.importClause.namedBindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              (element.propertyName ?? element.name).text === 'createRequire',
          )));
    if (runtimeCreateRequireImport) return true;
    if (statement.importClause.name) factoryNamespaceNames.add(statement.importClause.name.text);
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      factoryNamespaceNames.add(namedBindings.name.text);
      continue;
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === 'createRequire')
          factoryNames.add(element.name.text);
      }
    }
  }

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    const add = (set, name) => {
      if (!set.has(name)) {
        set.add(name);
        aliasesChanged = true;
      }
    };
    const isFactoryExpression = (expression) =>
      (ts.isIdentifier(expression) && factoryNames.has(expression.text)) ||
      (ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        factoryNamespaceNames.has(expression.expression.text) &&
        expression.name.text === 'createRequire') ||
      (ts.isElementAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        factoryNamespaceNames.has(expression.expression.text) &&
        expression.argumentExpression !== undefined &&
        (ts.isStringLiteral(expression.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)) &&
        expression.argumentExpression.text === 'createRequire');
    const classifyAlias = (name, initializer) => {
      if (ts.isIdentifier(initializer)) {
        if (factoryNames.has(initializer.text)) add(factoryNames, name);
        if (factoryNamespaceNames.has(initializer.text)) add(factoryNamespaceNames, name);
        if (loaderNames.has(initializer.text)) add(loaderNames, name);
      }
      if (isFactoryExpression(initializer)) add(factoryNames, name);
      if (ts.isCallExpression(initializer) && isFactoryExpression(initializer.expression))
        add(loaderNames, name);
    };
    const visitAliases = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) classifyAlias(node.name.text, node.initializer);
        if (
          ts.isObjectBindingPattern(node.name) &&
          ts.isIdentifier(node.initializer) &&
          factoryNamespaceNames.has(node.initializer.text)
        ) {
          for (const element of node.name.elements) {
            if (
              ts.isIdentifier(element.name) &&
              (element.propertyName ?? element.name).text === 'createRequire'
            )
              add(factoryNames, element.name.text);
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      )
        classifyAlias(node.left.text, node.right);
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }

  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && loaderNames.has(node.expression.text)) ||
        (ts.isCallExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            factoryNames.has(node.expression.expression.text)) ||
            (ts.isPropertyAccessExpression(node.expression.expression) &&
              ts.isIdentifier(node.expression.expression.expression) &&
              factoryNamespaceNames.has(node.expression.expression.expression.text) &&
              node.expression.expression.name.text === 'createRequire') ||
            (ts.isElementAccessExpression(node.expression.expression) &&
              ts.isIdentifier(node.expression.expression.expression) &&
              factoryNamespaceNames.has(node.expression.expression.expression.text) &&
              node.expression.expression.argumentExpression !== undefined &&
              (ts.isStringLiteral(node.expression.expression.argumentExpression) ||
                ts.isNoSubstitutionTemplateLiteral(
                  node.expression.expression.argumentExpression,
                )) &&
              node.expression.expression.argumentExpression.text === 'createRequire'))))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveRepositoryModule(fromPath, specifier, repositoryPaths) {
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  const extension = posix.extname(joined);
  const candidates = [joined];
  if (extension) {
    const stem = joined.slice(0, -extension.length);
    if (/^\.[cm]?js$/iu.test(extension))
      candidates.push(`${stem}.ts`, `${stem}.mts`, `${stem}.cts`, `${stem}.js`, `${stem}.mjs`);
  } else {
    candidates.push(
      `${joined}.ts`,
      `${joined}.mts`,
      `${joined}.cts`,
      `${joined}.js`,
      `${joined}.mjs`,
      `${joined}.sql`,
      `${joined}/index.ts`,
      `${joined}/index.mts`,
      `${joined}/index.js`,
    );
  }
  return candidates.find((candidate) => repositoryPaths.has(candidate)) ?? null;
}

function expressionExecutesCode(expression) {
  let executes = false;
  const visit = (node) => {
    if (executes || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
    ) {
      executes = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return executes;
}

function isSafeHeritageExpression(expression) {
  if (ts.isIdentifier(expression)) return true;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    return isSafeHeritageExpression(expression.expression);
  return false;
}

function isDeferredFunctionExpression(expression) {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function hasTopLevelExecutableCode(path, content) {
  if (!SCRIPT_MIGRATION_PATTERN.test(path)) return false;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0)
    throw new Error(`Migration dependency ${path} is not valid TypeScript`);

  return sourceFile.statements.some((statement) => {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return false;
    if (ts.isModuleDeclaration(statement)) {
      const declared =
        (statement.flags & ts.NodeFlags.Ambient) !== 0 ||
        (ts.canHaveModifiers(statement) &&
          (ts.getModifiers(statement) ?? []).some(
            (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
          ));
      return !declared;
    }
    if (ts.isExportAssignment(statement))
      return (
        !isStaticDataExpression(statement.expression) &&
        !isDeferredFunctionExpression(statement.expression)
      );
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some(
        (declaration) =>
          declaration.initializer !== undefined &&
          !isStaticDataExpression(declaration.initializer) &&
          !isDeferredFunctionExpression(declaration.initializer),
      );
    if (ts.isClassDeclaration(statement)) {
      if ((ts.getDecorators(statement) ?? []).length > 0) return true;
      if (
        (statement.heritageClauses ?? []).some((clause) =>
          clause.types.some(
            (type) =>
              !isSafeHeritageExpression(type.expression) || expressionExecutesCode(type.expression),
          ),
        )
      )
        return true;
      return statement.members.some((member) => {
        if ((ts.getDecorators(member) ?? []).length > 0) return true;
        if (
          member.name !== undefined &&
          ts.isComputedPropertyName(member.name) &&
          (expressionExecutesCode(member.name.expression) ||
            !isStaticDataExpression(member.name.expression))
        )
          return true;
        if (ts.isClassStaticBlockDeclaration(member)) return true;
        const isStatic =
          ts.canHaveModifiers(member) &&
          (ts.getModifiers(member) ?? []).some(
            (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
          );
        return (
          isStatic &&
          ts.isPropertyDeclaration(member) &&
          member.initializer !== undefined &&
          !isStaticDataExpression(member.initializer) &&
          !isDeferredFunctionExpression(member.initializer)
        );
      });
    }
    if (ts.isEnumDeclaration(statement))
      return statement.members.some(
        (member) => member.initializer !== undefined && !isStaticDataExpression(member.initializer),
      );
    return !ts.isEmptyStatement(statement);
  });
}

function isMigrationExecutionModule(path, content) {
  return (
    isMigrationPath(path) ||
    GOVERNANCE_MIGRATION_PROVIDER_PATH.test(path) ||
    hasExpandMetadata(content, path)
  );
}

function hasRequestedCallableExport(path, content, requestedCallableBindings) {
  if (requestedCallableBindings.size === 0 || !SCRIPT_MIGRATION_PATTERN.test(path)) return false;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0)
    throw new Error(`Migration dependency ${path} is not valid TypeScript`);

  const hasModifier = (node, kind) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
  const callableLocals = new Set();
  const callableInitializer = (node) => {
    if (!node) return false;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return callableInitializer(node.expression);
    return (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isIdentifier(node) && callableLocals.has(node.text))
    );
  };

  let changed = true;
  while (changed) {
    changed = false;
    const addCallable = (name) => {
      if (!callableLocals.has(name)) {
        callableLocals.add(name);
        changed = true;
      }
    };
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) addCallable(statement.name.text);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            callableInitializer(declaration.initializer)
          )
            addCallable(declaration.name.text);
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(statement.expression.left) &&
        callableInitializer(statement.expression.right)
      )
        addCallable(statement.expression.left.text);
    }
  }

  const exportedCallables = new Set();
  const exportedValues = new Set();
  // Functions and classes are directly callable/constructable exports.
  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && exported) {
      if (defaultExport) exportedCallables.add('default');
      else if (statement.name) exportedCallables.add(statement.name.text);
      continue;
    }
    if (ts.isClassDeclaration(statement) && exported) {
      const exportName = defaultExport ? 'default' : statement.name?.text;
      if (exportName) {
        exportedValues.add(exportName);
        exportedCallables.add(exportName);
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) {
          exportedValues.add(declaration.name.text);
          if (callableLocals.has(declaration.name.text))
            exportedCallables.add(declaration.name.text);
        }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        exportedValues.add(element.name.text);
        const localName = (element.propertyName ?? element.name).text;
        if (callableLocals.has(localName)) exportedCallables.add(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exportedValues.add(statement.isExportEquals ? '*' : 'default');
      if (callableInitializer(statement.expression))
        exportedCallables.add(statement.isExportEquals ? '*' : 'default');
    }
  }

  return (
    (requestedCallableBindings.has('*') &&
      (exportedCallables.size > 0 || exportedValues.size > 0)) ||
    [...requestedCallableBindings].some(
      (binding) =>
        exportedCallables.has(binding) ||
        exportedCallables.has('*') ||
        (binding.includes('.') && exportedValues.has(binding.split('.')[0])),
    )
  );
}

function isDeclarativeSqlProvider(path, content, requestedBindings) {
  if (!SCRIPT_MIGRATION_PATTERN.test(path)) return false;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0)
    throw new Error(`Migration dependency ${path} is not valid TypeScript`);

  const expectedBindings = new Set(requestedBindings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (
            (expectedBindings.has('*') || expectedBindings.has(element.name.text)) &&
            !expectedBindings.has((element.propertyName ?? element.name).text)
          ) {
            expectedBindings.add((element.propertyName ?? element.name).text);
            changed = true;
          }
        }
      }
      if (
        ts.isExportAssignment(statement) &&
        !statement.isExportEquals &&
        (expectedBindings.has('*') || expectedBindings.has('default')) &&
        ts.isIdentifier(statement.expression) &&
        !expectedBindings.has(statement.expression.text)
      ) {
        expectedBindings.add(statement.expression.text);
        changed = true;
      }
    }
  }

  const literals = [];
  const collectLiterals = (node) => {
    if (isStaticSqlLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, collectLiterals);
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      (expectedBindings.has('*') || expectedBindings.has('default')) &&
      isStaticDataExpression(statement.expression)
    )
      collectLiterals(statement.expression);
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        (expectedBindings.has('*') || expectedBindings.has(declaration.name.text)) &&
        declaration.initializer &&
        isStaticDataExpression(declaration.initializer)
      )
        collectLiterals(declaration.initializer);
    }
  }
  return literals
    .flatMap(splitSqlStatements)
    .some((statement) => MIGRATION_PROVIDER_SQL_PATTERN.test(statement));
}

function buildMigrationDependencyClosure(execFileSync, cwd, sha) {
  const repositoryPaths = new Set(
    gitRead(execFileSync, cwd, ['ls-tree', '-r', '--name-only', sha, '--'])
      .split(/\r?\n/u)
      .filter(Boolean),
  );
  const roots = [...repositoryPaths].filter(isMigrationPath).sort();
  const closure = new Set(roots);
  const requestedByPath = new Map(roots.map((path) => [path, new Set(['*'])]));
  const callableByPath = new Map(roots.map((path) => [path, new Set()]));
  const sideEffectPaths = new Set();
  const processedSignatures = new Map();
  const queue = [...roots];
  const enqueue = (path, bindings, callableBindings, sideEffect = false) => {
    const current = requestedByPath.get(path) ?? new Set();
    const currentCallable = callableByPath.get(path) ?? new Set();
    let changed = false;
    if (sideEffect && !sideEffectPaths.has(path)) {
      sideEffectPaths.add(path);
      changed = true;
    }
    if (bindings.has('*')) {
      if (!current.has('*')) {
        current.clear();
        current.add('*');
        changed = true;
      }
    } else if (!current.has('*')) {
      for (const binding of bindings) {
        if (!current.has(binding)) {
          current.add(binding);
          changed = true;
        }
      }
    }
    if (callableBindings.has('*')) {
      if (!currentCallable.has('*')) {
        currentCallable.clear();
        currentCallable.add('*');
        changed = true;
      }
    } else if (!currentCallable.has('*')) {
      for (const binding of callableBindings) {
        if (!currentCallable.has(binding)) {
          currentCallable.add(binding);
          changed = true;
        }
      }
    }
    requestedByPath.set(path, current);
    callableByPath.set(path, currentCallable);
    if (changed) queue.push(path);
  };

  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) continue;
    const requestedBindings = requestedByPath.get(path) ?? new Set();
    const requestedCallableBindings = callableByPath.get(path) ?? new Set();
    const signature = `${sideEffectPaths.has(path) ? 'side-effect' : 'binding'}\0${[
      ...requestedBindings,
    ]
      .sort()
      .join('\0')}\0callable:${[...requestedCallableBindings].sort().join('\0')}`;
    if (processedSignatures.get(path) === signature) continue;
    processedSignatures.set(path, signature);
    const content = gitRead(execFileSync, cwd, ['show', `${sha}:${path}`]);
    if (hasUnprovenRuntimeModuleLoad(content, path))
      throw new Error(`Migration dependency ${path} uses dynamic import or require`);
    if (
      isMigrationExecutionModule(path, content) ||
      hasRequestedCallableExport(path, content, requestedCallableBindings) ||
      (sideEffectPaths.has(path) && hasTopLevelExecutableCode(path, content)) ||
      isDeclarativeSqlProvider(path, content, requestedBindings)
    )
      closure.add(path);
    if (!SCRIPT_MIGRATION_PATTERN.test(path)) continue;
    for (const dependencyRequest of relativeModuleDependencies(
      content,
      path,
      requestedBindings,
      requestedCallableBindings,
    )) {
      const dependency = resolveRepositoryModule(
        path,
        dependencyRequest.specifier,
        repositoryPaths,
      );
      if (dependency)
        enqueue(
          dependency,
          dependencyRequest.bindings,
          dependencyRequest.callableBindings,
          dependencyRequest.sideEffect,
        );
    }
  }
  return closure;
}

function fullContentAsAddedDiff(content) {
  const lines = content.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

function pathsFromNameStatus(value) {
  const paths = [];
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [status, ...fields] = line.split('\t');
    if (!status || fields.length === 0) continue;
    if (/^[RC]/u.test(status) && fields.length >= 2) paths.push(fields[0], fields[1]);
    else paths.push(fields[0]);
  }
  return paths;
}

export function createMigrationPlan({
  changedPaths,
  baseline,
  target,
  cwd = process.cwd(),
  execFileSync = defaultExecFileSync,
}) {
  const blockingReasons = [];
  if (!SHA_PATTERN.test(baseline ?? '')) blockingReasons.push('Migration baseline SHA is invalid.');
  if (!SHA_PATTERN.test(target ?? '')) blockingReasons.push('Migration target SHA is invalid.');
  if (blockingReasons.length > 0) return { ok: false, migrationPlan: null, blockingReasons };

  let candidatePaths = [...changedPaths];
  let baselineClosure = new Set();
  let targetClosure = new Set();
  const resolveDependencyClosure = candidatePaths.some(
    (path) => isMigrationPath(path) || SCRIPT_MIGRATION_PATTERN.test(path),
  );
  if (resolveDependencyClosure) {
    try {
      candidatePaths.push(
        ...pathsFromNameStatus(
          gitRead(execFileSync, cwd, [
            'diff',
            '--name-status',
            '--find-renames',
            baseline,
            target,
            '--',
          ]),
        ),
      );
      baselineClosure = buildMigrationDependencyClosure(execFileSync, cwd, baseline);
      targetClosure = buildMigrationDependencyClosure(execFileSync, cwd, target);
    } catch {
      blockingReasons.push(
        'Migration execution dependency closure could not be proven from the production baseline.',
      );
    }
  }

  const newlyReachable = new Set([...targetClosure].filter((path) => !baselineClosure.has(path)));
  const noLongerReachable = [...baselineClosure].filter((path) => !targetClosure.has(path));
  candidatePaths.push(...newlyReachable);
  for (const path of noLongerReachable) {
    blockingReasons.push(
      `Migration execution provider ${path} is no longer reachable; provider removal or rewiring requires a separate contract release.`,
    );
  }

  const paths = [
    ...new Set(
      candidatePaths.filter(
        (path) => isMigrationPath(path) || baselineClosure.has(path) || targetClosure.has(path),
      ),
    ),
  ].sort();
  const inventory = [];
  for (const path of paths) {
    let content;
    try {
      content = gitRead(execFileSync, cwd, ['show', `${target}:${path}`]);
    } catch {
      blockingReasons.push(
        `Migration ${path} is absent at the release SHA; migration removal or rename requires a separate contract release.`,
      );
      continue;
    }

    let diff;
    try {
      diff = newlyReachable.has(path)
        ? fullContentAsAddedDiff(content)
        : gitRead(execFileSync, cwd, [
            'diff',
            '--unified=0',
            '--no-ext-diff',
            baseline,
            target,
            '--',
            path,
          ]);
    } catch {
      blockingReasons.push(`Migration ${path} could not be compared with the production baseline.`);
      continue;
    }
    const additions = changedLines(diff, '+', '+++');
    const deletions = changedLines(diff, '-', '---');
    const scriptAnalysis = analyzeScriptMigration(content, diff, path);
    const sqlSources =
      SCRIPT_MIGRATION_PATTERN.test(path) && scriptAnalysis.staticLiterals.length > 0
        ? scriptAnalysis.staticLiterals
        : [additions];
    const sqlStatements = sqlSources.flatMap(splitSqlStatements);
    const scanText = normalizeSqlForClassification(
      `${additions}\n${scriptAnalysis.staticLiterals.join('\n')}`,
    );
    if (deletions.trim()) {
      blockingReasons.push(
        `Migration ${path} deletes or replaces baseline content and requires a separate contract release.`,
      );
    }
    if (!hasExpandMetadata(content, path)) {
      blockingReasons.push(
        `Migration ${path} lacks a standalone "release-migration: expand" comment at the release SHA.`,
      );
    }
    if (
      CONTRACT_PATTERN.test(scanText) ||
      hasRiskyAddColumn(scanText) ||
      sqlStatements.some((statement) => !isAllowedExpandSqlStatement(statement))
    ) {
      blockingReasons.push(
        `Migration ${path} contains a contract or non-whitelisted operation and cannot be promoted with an RC.`,
      );
    }
    if (
      DYNAMIC_SQL_PATTERN.test(scanText) ||
      UNKNOWN_SQL_PATTERN.test(scanText) ||
      scriptAnalysis.unsafe
    ) {
      blockingReasons.push(
        `Migration ${path} contains dynamic, custom-query, or lexically ambiguous SQL that cannot be classified deterministically.`,
      );
    }
    inventory.push({
      path,
      targetBlobDigest: digest(content),
      addedLinesDigest: digest(additions),
      deletedLinesDigest: digest(deletions),
      classification: 'expand',
    });
  }

  const phase = paths.length === 0 ? 'none' : 'expand';
  const planBody = {
    schemaVersion: 2,
    baselineSha: baseline,
    releaseSha: target,
    phase,
    files: inventory,
  };
  return {
    ok: blockingReasons.length === 0,
    migrationPlan: {
      phase,
      planDigest: digest(canonicalJson(planBody)),
      confirmation: phase === 'none' ? 'not_required' : 'required_after_observation',
      contract: 'separate_release',
    },
    blockingReasons,
  };
}

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  if (!options['changed-paths'] || !options.baseline || !options.target)
    throw new Error(
      'usage: migration-plan.mjs --changed-paths <classification.json> --baseline <sha> --target <sha>',
    );
  const input = JSON.parse(await readFile(options['changed-paths'], 'utf8'));
  const result = createMigrationPlan({
    changedPaths: input.changedFiles,
    baseline: options.baseline,
    target: options.target,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

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

const ALLOWED_EXPAND_ALTER_PATTERN =
  /^ALTER\s+TABLE\s+\S+\s+(?:ADD\s+(?:COLUMN\s+)?|ADD\s+CONSTRAINT\b|VALIDATE\s+CONSTRAINT\b)/iu;
const ALLOWED_EXPAND_CREATE_PATTERN =
  /^CREATE\s+(?:(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?|TABLE|SEQUENCE)\b/iu;
const ALLOWED_CREATE_PAREN_KEYWORDS = new Set([
  'as',
  'bit',
  'char',
  'character',
  'check',
  'decimal',
  'exclude',
  'hash',
  'include',
  'interval',
  'key',
  'lower',
  'numeric',
  'range',
  'time',
  'timestamp',
  'unique',
  'varbit',
  'varchar',
  'with',
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
    hasUnprovenAlterFunction(statement) ||
    hasUnprovenCreateFunction(statement)
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
    const allowedKeyword =
      !name.startsWith('"') && ALLOWED_CREATE_PAREN_KEYWORDS.has(name.toLowerCase());
    if (allowedKeyword) continue;
    return true;
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

function hasRiskyAddColumn(value) {
  return operationSlices(value, 'ALTER').some(
    (statement) =>
      !/^ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\b/iu.test(statement) &&
      /^ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+[^;\n]*\bNOT\s+NULL\b/iu.test(
        statement,
      ),
  );
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
  const memberReference = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return { owner: node.expression.text, member: node.name.text };
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return { owner: node.expression.text, member: node.argumentExpression.text };
    return undefined;
  };
  const markCallableMember = (node) => {
    const reference = memberReference(node);
    if (!reference) return;
    const members = calledMemberBindings.get(reference.owner) ?? new Set();
    members.add(reference.member);
    calledMemberBindings.set(reference.owner, members);
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
  // Unknown higher-order APIs are fail-closed: imported callable arguments stay in the closure.
  const callbackArgumentIndexes = (node) => {
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Promise') return [0];
      return node.arguments?.map((_, index) => index) ?? [];
    }
    if (!ts.isCallExpression(node)) return [];
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
    if (ts.isSpreadElement(node)) {
      collectCallableReference(node.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectCallableReference(element);
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

  let calledAliasesChanged = true;
  while (calledAliasesChanged) {
    calledAliasesChanged = false;
    const collectAliasSources = (node) => {
      if (ts.isIdentifier(node) && !calledIdentifiers.has(node.text)) {
        calledIdentifiers.add(node.text);
        calledAliasesChanged = true;
      }
      ts.forEachChild(node, collectAliasSources);
    };
    const visitAliases = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
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
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isCalledReference(node.left)
      )
        collectAliasSources(node.right);
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }

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
        if (
          callableLocalBindings.has(element.name.text) &&
          !callableLocalBindings.has((element.propertyName ?? element.name).text)
        ) {
          callableLocalBindings.add((element.propertyName ?? element.name).text);
          callableAliasesChanged = true;
        }
      }
    }
  }

  const dependencies = [];
  const requestedAll = requestedBindings.has('*');
  const requestedCallableAll = requestedCallableBindings.has('*');
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
          if (
            calledIdentifiers.has(clause.name.text) ||
            callableLocalBindings.has(clause.name.text)
          )
            callableBindings.add('default');
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            bindings.add('*');
            const localName = clause.namedBindings.name.text;
            const calledMembers = calledMemberBindings.get(localName);
            if (calledMembers) for (const member of calledMembers) callableBindings.add(member);
            if (
              callableLocalBindings.has(localName) ||
              (calledIdentifiers.has(localName) && !calledMembers?.size)
            )
              callableBindings.add('*');
          } else {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              const importedName = (element.propertyName ?? element.name).text;
              bindings.add(importedName);
              if (
                calledIdentifiers.has(element.name.text) ||
                callableLocalBindings.has(element.name.text)
              )
                callableBindings.add(importedName);
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
        if (requestedCallableAll || requestedCallableBindings.has(statement.exportClause.name.text))
          callableBindings.add('*');
      } else {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          if (requestedAll || requestedBindings.has(element.name.text))
            bindings.add((element.propertyName ?? element.name).text);
          if (requestedCallableAll || requestedCallableBindings.has(element.name.text))
            callableBindings.add((element.propertyName ?? element.name).text);
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
  for (const statement of sourceFile.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const defaultExport = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && exported) {
      if (defaultExport) exportedCallables.add('default');
      else if (statement.name) exportedCallables.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && callableLocals.has(declaration.name.text))
          exportedCallables.add(declaration.name.text);
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
        const localName = (element.propertyName ?? element.name).text;
        if (callableLocals.has(localName)) exportedCallables.add(element.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && callableInitializer(statement.expression))
      exportedCallables.add(statement.isExportEquals ? '*' : 'default');
  }

  return (
    (requestedCallableBindings.has('*') && exportedCallables.size > 0) ||
    [...requestedCallableBindings].some(
      (binding) => exportedCallables.has(binding) || exportedCallables.has('*'),
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

import { createHash } from 'node:crypto';
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import ts from 'typescript';
import { canonicalJson, SHA_PATTERN } from './artifact-lib.mjs';
import { loadMigrationReviews } from './migration-reviews.mjs';

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
// Only executable JS/TS modules participate in the migration import graph.
const SCRIPT_MIGRATION_PATTERN = /\.(?:[cm]?[jt]s)$/iu;
const RELATIVE_MODULE_SPECIFIER = /^\.{1,2}\//u;
const GOVERNANCE_MIGRATION_PROVIDER_PATH =
  /^server\/src\/data\/governance-schema\/[^/]*migrations?\.ts$/iu;
const PRODUCTION_SCHEMA_MODULE_PATH =
  /^server\/src\/(?!.*(?:__tests__|\.test\.|\.pg\.test\.))[^/].*\.(?:[cm]?[jt]s)$/iu;
export const PRODUCTION_STARTUP_SCHEMA_ROOTS = Object.freeze([
  'server/src/app/runtimeGovernanceConnectors.ts',
  'server/src/connectors/googleWorkspace.ts',
  'server/src/data/agentDwsAccounts/store.ts',
  'server/src/data/agentDwsMessages/store.ts',
  'server/src/data/agentProfiles/store.ts',
  'server/src/data/agentResources/store.ts',
  'server/src/data/appeals/store.ts',
  'server/src/data/assignments/store.ts',
  'server/src/data/billing/pgBillingStore.ts',
  'server/src/data/changeJobs/store.ts',
  'server/src/data/connectorCatalog/store.ts',
  'server/src/data/connectorDictionaryStore.ts',
  'server/src/data/contentAccess/store.ts',
  'server/src/data/credentials/store.ts',
  'server/src/data/directoryGroups/store.ts',
  'server/src/data/entitlements/store.ts',
  'server/src/data/environments/store.ts',
  'server/src/data/feedback/store.ts',
  'server/src/data/governance-audit/store.ts',
  'server/src/data/guardrail/pgGuardrailEventStore.ts',
  'server/src/data/memberships/store.ts',
  'server/src/data/migrationControl/store.ts',
  'server/src/data/oauthGrants/store.ts',
  'server/src/data/orgGroupAgents/store.ts',
  'server/src/data/resourceReferences/store.ts',
  'server/src/data/sessionReadStateStore.ts',
  'server/src/data/sessionShares/store.ts',
  'server/src/data/skillGovernance/store.ts',
  'server/src/data/skillPresentations/store.ts',
  'server/src/dws/authStore.ts',
  'server/src/dws/store.ts',
  'server/src/feishu/authStore.ts',
  'server/src/feishu/store.ts',
  'server/src/memory/consolidation/scannerStatus.ts',
  'server/src/memory/consolidation/store.ts',
  'server/src/quota/providerQuotaSnapshotStore.ts',
  'server/src/runtime/alertStateStore.ts',
  'server/src/runtime/artifactShareStore.ts',
  'server/src/runtime/artifactStore.ts',
  'server/src/runtime/auditProjection.ts',
  'server/src/runtime/clientDaemonRegistry.ts',
  'server/src/runtime/handStore.ts',
  'server/src/runtime/imageBlobStore.ts',
  'server/src/runtime/pgEventStore.ts',
  'server/src/runtime/pgSessionLock.ts',
  'server/src/runtime/responses/codexCredentialRuntimeState.ts',
  'server/src/runtime/runResolutionSnapshotStore.ts',
  'server/src/runtime/runStore.ts',
  'server/src/runtime/runStoreSchema.ts',
  'server/src/runtime/runTerminalOutboxStore.ts',
  'server/src/runtime/runtimeSchedulerConfigStore.ts',
  'server/src/runtime/sessionAutomationStore.ts',
  'server/src/runtime/sessionProjectionStore.ts',
  'server/src/runtime/systemMetricsStore.ts',
  'server/src/runtime/toolInvocationStore.ts',
  'server/src/taskboard/store.ts',
  'server/src/taskboard/storeSchema.ts',
  'server/src/webPush/store.ts',
  'server/src/workspace/materialization/store.ts',
]);
// This explicit list is the production authority on both sides of the comparison; every root's
// static reachability is intersected with the complete baseline-to-target diff before deep analysis.
const STARTUP_SCHEMA_ENTRY_PATTERN =
  /\b(?:async\s+)?(?:function\s+(?:init|initialize)[A-Za-z0-9_$]*\s*\(|(?:init|initialize[A-Za-z0-9_$]*)\s*\([^)]*\)\s*:\s*Promise\s*<)/u;
// Future init/initialize modules are recognized when their own file changes.
const SCHEMA_DDL_PATTERN =
  /\b(?:ALTER\s+TABLE|COMMENT\s+ON|CREATE\s+(?:(?:OR\s+REPLACE|UNIQUE)\s+)*(?:EXTENSION|FUNCTION|INDEX|MATERIALIZED\s+VIEW|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|VIEW)|DROP\s+(?:EXTENSION|FUNCTION|INDEX|MATERIALIZED\s+VIEW|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|VIEW)|GRANT\b|REVOKE\b|TRUNCATE(?:\s+TABLE)?\b)/iu;
const STARTUP_DATA_MUTATION_PATTERN =
  /\b(?:DELETE\s+FROM|INSERT\s+INTO|MERGE\s+INTO|REPLACE\s+INTO|UPDATE\s+(?:ONLY\s+)?\S+(?:\s+\*)?(?:\s+(?:AS\s+)?\S+)?\s+SET)\b/iu;

export function isProductionStartupSchemaRootSource(path, content) {
  return (
    PRODUCTION_SCHEMA_MODULE_PATH.test(path) &&
    STARTUP_SCHEMA_ENTRY_PATTERN.test(content) &&
    (SCHEMA_DDL_PATTERN.test(content) || STARTUP_DATA_MUTATION_PATTERN.test(content))
  );
}

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
  // packages/ 下是发给定制项目的契约包（含其模板与 SQL），作用于客户自己的数据库，
  // 不属于 agent-saas 生产迁移，不进发布迁移计划。
  if (normalized.startsWith('packages/')) return false;
  return MIGRATION_PATHS.some((pattern) => pattern.test(normalized));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function gitRead(execFileSync, cwd, args) {
  return String(
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A repository filename must never be interpreted as pathspec syntax.
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    }),
  );
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

// 统一按 unified diff 还原「某一侧被改动的行号」：'+' 取目标侧新增行，'-' 取基线侧删除行。
function changedSourceLines(diff, side) {
  const isTarget = side === '+';
  const other = isTarget ? '-' : '+';
  const lines = new Set();
  let cursor = null;
  for (const line of diff.split(/\r?\n/u)) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u);
    if (hunk) {
      cursor = Number(isTarget ? hunk[2] : hunk[1]);
      continue;
    }
    if (cursor === null || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith(side)) {
      lines.add(cursor);
      cursor += 1;
    } else if (!line.startsWith(other)) cursor += 1;
  }
  return lines;
}

function addedTargetLines(diff) {
  return changedSourceLines(diff, '+');
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

// 文本是否呈现任何 SQL 形态：迁移语句、contract 语句、动态 SQL 或无法分类的语句都算。
// 判定前统一走 normalizeSqlForClassification，未闭合注释/引号会被规范化成显式标记而落入 unsafe 侧。
function hasSqlShape(value) {
  const normalized = normalizeSqlForClassification(value);
  return (
    MIGRATION_PROVIDER_SQL_PATTERN.test(normalized) ||
    CONTRACT_PATTERN.test(normalized) ||
    DYNAMIC_SQL_PATTERN.test(normalized) ||
    UNKNOWN_SQL_PATTERN.test(normalized)
  );
}

// 提取整份源码里全部呈 SQL 形态的静态字面量（含带插值模板的原始文本），按序列化后比较，
// 用于回答「本次变更有没有动过任何 SQL」。基线侧与目标侧都要跑，缺一侧就无法比较。
// 返回 null 表示无法判定（非脚本文件或解析失败），调用方必须回退到严格逻辑。
function staticSqlLiteralSignature(content, path) {
  if (content === null || !SCRIPT_MIGRATION_PATTERN.test(path)) return null;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) return null;
  const literals = [];
  const collect = (node) => {
    if (isStaticSqlLiteral(node)) {
      if (hasSqlShape(node.text)) literals.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // 带插值的模板整体取原始文本：插值本身就是 SQL 拼接，必须参与比较。
      const raw = node.getText(sourceFile);
      if (hasSqlShape(raw)) literals.push(raw);
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(sourceFile, collect);
  return JSON.stringify(literals.sort());
}

// 变更行是否碰到任何「import 时会执行代码」的顶层语句。解析不了一律当作碰到了。
function changeTouchesTopLevelExecutableStatement(content, path, lines) {
  if (lines.size === 0) return false;
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) return true;
  return sourceFile.statements.some(
    (statement) =>
      touchesAddedLine(sourceFile, statement, lines) && isTopLevelExecutableStatement(statement),
  );
}

// 迁移闭包里的依赖模块（不是迁移根、也没有 expand 注释）如果本次变更完全没碰 SQL，
// 自动判为 no-schema-change：两端 SQL 静态字面量集合完全相同、增删行文本不含任何 SQL 形态，
// 且两端变更行都没有触碰 import 时会执行代码的顶层语句（否则 SQL 可能不经字面量落地）。
// 任何一条不满足都返回 false，回到原有严格逻辑（删除即 contract、缺 expand 注释即阻断）。
function isSqlNeutralDependencyChange({
  path,
  content,
  baselineContent,
  diff,
  additions,
  deletions,
}) {
  if (!SCRIPT_MIGRATION_PATTERN.test(path)) return false;
  if (isMigrationPath(path) || GOVERNANCE_MIGRATION_PROVIDER_PATH.test(path)) return false;
  if (hasExpandMetadata(content, path)) return false;
  const targetSignature = staticSqlLiteralSignature(content, path);
  // baselineContent 为 null 表示基线不存在该文件（新增/新纳入闭包）；非字符串表示读不到，无法判定。
  let baselineSignature = null;
  if (baselineContent === null) baselineSignature = '[]';
  else if (typeof baselineContent === 'string')
    baselineSignature = staticSqlLiteralSignature(baselineContent, path);
  if (targetSignature === null || baselineSignature === null) return false;
  if (targetSignature !== baselineSignature) return false;
  if (hasSqlShape(`${additions}\n${deletions}`)) return false;
  if (changeTouchesTopLevelExecutableStatement(content, path, changedSourceLines(diff, '+')))
    return false;
  const deletedLines = changedSourceLines(diff, '-');
  if (deletedLines.size === 0) return true;
  return (
    typeof baselineContent === 'string' &&
    !changeTouchesTopLevelExecutableStatement(baselineContent, path, deletedLines)
  );
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
  // Proven wrappers preserve descriptor targets and keys across local, computed reads/writes, nested/spread member, multi-hop factory return, destructured, and invocation aliases.
  const descriptorFactories = new Map();
  const unprovenDescriptorFactories = new Set();
  const returnedFactoryExpression = (body) => {
    if (!ts.isBlock(body)) return { returned: unwrapExpression(body), localValues: new Map() };
    const returns = [];
    const localValues = new Map();
    const ambiguousLocalValues = new Set();
    const registerLocalValue = (name, value) => {
      if (ambiguousLocalValues.has(name)) return;
      if (localValues.has(name)) {
        localValues.delete(name);
        ambiguousLocalValues.add(name);
        return;
      }
      localValues.set(name, unwrapExpression(value));
    };
    const assignmentOperators = new Set([
      ts.SyntaxKind.EqualsToken,
      ts.SyntaxKind.PlusEqualsToken,
      ts.SyntaxKind.MinusEqualsToken,
      ts.SyntaxKind.AsteriskEqualsToken,
      ts.SyntaxKind.AsteriskAsteriskEqualsToken,
      ts.SyntaxKind.SlashEqualsToken,
      ts.SyntaxKind.PercentEqualsToken,
      ts.SyntaxKind.LessThanLessThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.AmpersandEqualsToken,
      ts.SyntaxKind.BarEqualsToken,
      ts.SyntaxKind.CaretEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken,
      ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ]);
    const markAmbiguousLocalValue = (name) => {
      localValues.delete(name);
      ambiguousLocalValues.add(name);
    };
    const markAssignedBindingsAmbiguous = (target) => {
      const current = unwrapExpression(target);
      if (ts.isIdentifier(current)) {
        markAmbiguousLocalValue(current.text);
        return;
      }
      ts.forEachChild(current, markAssignedBindingsAmbiguous);
    };
    const collectLocalValues = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        registerLocalValue(node.name.text, node.initializer);
      if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left))
          registerLocalValue(node.left.text, node.right);
        else markAssignedBindingsAmbiguous(node.left);
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        ts.isIdentifier(node.operand)
      )
        markAssignedBindingsAmbiguous(node.operand);
      if (!ts.isFunctionLike(node) || node === body) ts.forEachChild(node, collectLocalValues);
    };
    collectLocalValues(body);
    const collectReturns = (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        returns.push(unwrapExpression(node.expression));
        return;
      }
      if (!ts.isFunctionLike(node) || node === body) ts.forEachChild(node, collectReturns);
    };
    collectReturns(body);
    if (returns.length !== 1) return undefined;
    let returned = returns[0];
    const visited = new Set();
    while (ts.isIdentifier(returned) && localValues.has(returned.text)) {
      if (visited.has(returned.text)) return undefined;
      visited.add(returned.text);
      returned = localValues.get(returned.text);
    }
    return { returned, localValues, ambiguousLocalValues };
  };
  const containsDescriptorCall = (body) => {
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (
        ['Reflect', 'Object'].some((owner) =>
          isMethodCall(node, owner, 'getOwnPropertyDescriptor'),
        ) ||
        isMethodCall(node, 'Object', 'getOwnPropertyDescriptors')
      ) {
        found = true;
        return;
      }
      if (!ts.isFunctionLike(node) || node === body) ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  const registerDescriptorFactory = (name, parameters, body) => {
    if (containsDescriptorCall(body)) unprovenDescriptorFactories.add(name);
    const returnedFactory = returnedFactoryExpression(body);
    if (!returnedFactory) return;
    const { returned, localValues, ambiguousLocalValues = new Set() } = returnedFactory;
    const parameterNames = parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
    );
    const parameterBindingNames = new Set();
    const collectBindingNames = (name) => {
      if (ts.isIdentifier(name)) {
        parameterBindingNames.add(name.text);
        return;
      }
      for (const element of name.elements)
        if (ts.isBindingElement(element)) collectBindingNames(element.name);
    };
    for (const parameter of parameters) {
      collectBindingNames(parameter.name);
      const names = new Set();
      const collectParameterNames = (name) => {
        if (ts.isIdentifier(name)) {
          names.add(name.text);
          return;
        }
        for (const element of name.elements)
          if (ts.isBindingElement(element)) collectParameterNames(element.name);
      };
      collectParameterNames(parameter.name);
      for (const parameterName of names) {
        if (
          parameter.initializer ||
          !ts.isIdentifier(parameter.name) ||
          localValues.has(parameterName) ||
          ambiguousLocalValues.has(parameterName)
        ) {
          localValues.delete(parameterName);
          ambiguousLocalValues.add(parameterName);
        }
      }
    }
    for (const owner of ['Reflect', 'Object']) {
      if (!isMethodCall(returned, owner, 'getOwnPropertyDescriptor')) continue;
      const [target, key] = methodCallArguments(returned, owner, 'getOwnPropertyDescriptor');
      if (target && key)
        descriptorFactories.set(name, {
          kind: 'member',
          parameters: parameterNames,
          localValues,
          ambiguousLocalValues,
          parameterBindingNames,
          target,
          key,
        });
      unprovenDescriptorFactories.delete(name);
      return;
    }
    if (!isMethodCall(returned, 'Object', 'getOwnPropertyDescriptors')) return;
    const [target] = methodCallArguments(returned, 'Object', 'getOwnPropertyDescriptors');
    if (target)
      descriptorFactories.set(name, {
        kind: 'container',
        parameters: parameterNames,
        localValues,
        ambiguousLocalValues,
        parameterBindingNames,
        target,
      });
    unprovenDescriptorFactories.delete(name);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      registerDescriptorFactory(statement.name.text, statement.parameters, statement.body);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      )
        registerDescriptorFactory(
          declaration.name.text,
          declaration.initializer.parameters,
          declaration.initializer.body,
        );
    }
  }
  const descriptorFactoryReturnValues = new Map();
  const registerDescriptorFactoryReturn = (name, body) => {
    const returnedFactory = returnedFactoryExpression(body);
    if (returnedFactory) descriptorFactoryReturnValues.set(name, returnedFactory.returned);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      registerDescriptorFactoryReturn(statement.name.text, statement.body);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      )
        registerDescriptorFactoryReturn(declaration.name.text, declaration.initializer.body);
    }
  }
  const descriptorFactoryAliasWrites = new Map();
  const descriptorFactoryAliasReferences = new Map();
  const descriptorFactoryObjectSpreadReferences = new Map();
  const descriptorFactoryDynamicMemberWrites = new Map();
  const descriptorFactoryDynamicMemberReferences = new Map();
  const descriptorFactoryArrayLengths = new Map();
  const descriptorFactoryOwnerAliases = new Map();
  const addDescriptorFactoryOwnerAlias = (left, right) => {
    if (!left || !right || left === right) return;
    for (const [source, target] of [
      [left, right],
      [right, left],
    ]) {
      const aliases = descriptorFactoryOwnerAliases.get(source) ?? new Set();
      aliases.add(target);
      descriptorFactoryOwnerAliases.set(source, aliases);
    }
  };
  const addDescriptorFactoryAliasWrite = (name, expression) => {
    const current = unwrapExpression(expression);
    const writes = descriptorFactoryAliasWrites.get(name) ?? [];
    if (!writes.includes(current)) writes.push(current);
    descriptorFactoryAliasWrites.set(name, writes);
    addDescriptorFactoryOwnerAlias(name, staticDescriptorAliasReferenceKey(current));
  };
  const addDescriptorFactoryAliasReference = (name, reference) => {
    const references = descriptorFactoryAliasReferences.get(name) ?? [];
    if (!references.includes(reference)) references.push(reference);
    descriptorFactoryAliasReferences.set(name, references);
  };
  const addDescriptorFactoryObjectSpreadReference = (owner, reference) => {
    const references = descriptorFactoryObjectSpreadReferences.get(owner) ?? [];
    references.push(reference);
    descriptorFactoryObjectSpreadReferences.set(owner, references);
  };
  const addDescriptorFactoryDynamicMemberWrite = (owner, expression) => {
    const current = unwrapExpression(expression);
    const writes = descriptorFactoryDynamicMemberWrites.get(owner) ?? [];
    if (!writes.includes(current)) writes.push(current);
    descriptorFactoryDynamicMemberWrites.set(owner, writes);
  };
  const addDescriptorFactoryDynamicMemberReference = (owner, reference) => {
    const references = descriptorFactoryDynamicMemberReferences.get(owner) ?? [];
    if (!references.includes(reference)) references.push(reference);
    descriptorFactoryDynamicMemberReferences.set(owner, references);
  };
  const descriptorFactoryOwnerClosure = (owner) => {
    const closure = new Set();
    const pending = [owner];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || closure.has(current)) continue;
      closure.add(current);
      for (const alias of descriptorFactoryOwnerAliases.get(current) ?? []) pending.push(alias);
      for (const spread of descriptorFactoryObjectSpreadReferences.get(current) ?? [])
        pending.push(spread);
    }
    return closure;
  };
  const staticObjectPropertyName = (node) => {
    if (!node) return undefined;
    const current = unwrapExpression(node);
    if (ts.isComputedPropertyName(current)) {
      const key = staticMemberKey(current.expression);
      return key === '*' ? undefined : key;
    }
    if (ts.isIdentifier(current) || ts.isStringLiteral(current) || ts.isNumericLiteral(current))
      return current.text;
    return staticMemberKey(current);
  };
  const staticDescriptorAliasReferenceKey = (node) => {
    const current = unwrapExpression(node);
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) {
      const owner = staticDescriptorAliasReferenceKey(current.expression);
      return owner ? `${owner}.${current.name.text}` : undefined;
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      const owner = staticDescriptorAliasReferenceKey(current.expression);
      const member = staticMemberKey(current.argumentExpression);
      return owner && member !== '*' ? `${owner}.${member}` : undefined;
    }
    return undefined;
  };
  const objectLiteralPropertyValue = (object, key) => {
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    for (const property of object.properties) {
      const propertyKey = staticObjectPropertyName(property.name);
      if (propertyKey !== key) continue;
      if (ts.isShorthandPropertyAssignment(property)) return property.name;
      if (ts.isPropertyAssignment(property)) return property.initializer;
    }
    return undefined;
  };
  const resolveDescriptorFactoryObjectLiteralName = (name, visited = new Set()) => {
    if (visited.has(name)) return undefined;
    const writes = descriptorFactoryAliasWrites.get(name) ?? [];
    const references = descriptorFactoryAliasReferences.get(name) ?? [];
    const nextVisited = new Set(visited).add(name);
    const resolved = new Set();
    for (const reference of references) {
      const target = resolveDescriptorFactoryObjectLiteralName(reference, nextVisited);
      if (target) resolved.add(target);
    }
    for (const write of writes) {
      const current = unwrapExpression(write);
      if (ts.isObjectLiteralExpression(current)) resolved.add(current);
      else {
        const reference = staticDescriptorAliasReferenceKey(current);
        const target = reference
          ? resolveDescriptorFactoryObjectLiteralName(reference, nextVisited)
          : undefined;
        if (target) resolved.add(target);
      }
    }
    if (resolved.size === 0) return undefined;
    if (writes.length + references.length !== 1 || resolved.size !== 1)
      throw new Error(`descriptor wrapper object alias ${name} cannot be proven statically`);
    return [...resolved][0];
  };
  const resolveDescriptorFactoryObjectLiteral = (expression) => {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current)) return current;
    const reference = staticDescriptorAliasReferenceKey(current);
    return reference ? resolveDescriptorFactoryObjectLiteralName(reference) : undefined;
  };
  const descriptorFactoryObjectValues = (object) =>
    ['value', 'get', 'set']
      .map((key) => objectLiteralPropertyValue(object, key))
      .filter((value) => value);
  const addDescriptorFactoryDescriptorReferenceWrites = (
    destinationOwner,
    destinationMember,
    reference,
  ) => {
    let added = false;
    const addWrite = (value) => {
      added = true;
      if (destinationMember === '*')
        addDescriptorFactoryDynamicMemberWrite(destinationOwner, value);
      else addDescriptorFactoryAliasWrite(`${destinationOwner}.${destinationMember}`, value);
    };
    const addReference = (value) => {
      added = true;
      if (destinationMember === '*')
        addDescriptorFactoryDynamicMemberReference(destinationOwner, value);
      else addDescriptorFactoryAliasReference(`${destinationOwner}.${destinationMember}`, value);
    };
    for (const owner of descriptorFactoryOwnerClosure(reference)) {
      for (const field of ['value', 'get', 'set']) {
        const member = `${owner}.${field}`;
        for (const write of descriptorFactoryAliasWrites.get(member) ?? []) addWrite(write);
        for (const target of descriptorFactoryAliasReferences.get(member) ?? [])
          addReference(target);
      }
      for (const write of descriptorFactoryDynamicMemberWrites.get(owner) ?? []) addWrite(write);
      for (const target of descriptorFactoryDynamicMemberReferences.get(owner) ?? [])
        addReference(target);
    }
    return added;
  };
  const addDescriptorFactoryDescriptorWrites = (
    destinationOwner,
    destinationMember,
    expression,
  ) => {
    let added = false;
    const addWrite = (value) => {
      added = true;
      if (destinationMember === '*')
        addDescriptorFactoryDynamicMemberWrite(destinationOwner, value);
      else addDescriptorFactoryAliasWrite(`${destinationOwner}.${destinationMember}`, value);
    };
    const descriptor = resolveDescriptorFactoryObjectLiteral(expression);
    if (descriptor) for (const value of descriptorFactoryObjectValues(descriptor)) addWrite(value);
    const reference = staticDescriptorAliasReferenceKey(expression);
    if (reference)
      added =
        addDescriptorFactoryDescriptorReferenceWrites(
          destinationOwner,
          destinationMember,
          reference,
        ) || added;
    if (!added) addDescriptorFactoryDynamicMemberWrite(destinationOwner, expression);
  };
  const addDescriptorFactoryDescriptorsMapWrites = (destinationOwner, expression) => {
    const descriptors = resolveDescriptorFactoryObjectLiteral(expression);
    if (descriptors)
      for (const property of descriptors.properties) {
        if (ts.isPropertyAssignment(property))
          addDescriptorFactoryDescriptorWrites(
            destinationOwner,
            staticObjectPropertyName(property.name) ?? '*',
            property.initializer,
          );
        else if (ts.isSpreadAssignment(property))
          addDescriptorFactoryDynamicMemberWrite(destinationOwner, property.expression);
        else addDescriptorFactoryDynamicMemberWrite(destinationOwner, expression);
      }
    const reference = staticDescriptorAliasReferenceKey(expression);
    if (!reference) return;
    let added = false;
    for (const owner of descriptorFactoryOwnerClosure(reference)) {
      const prefix = `${owner}.`;
      const members = new Set();
      for (const name of [...descriptorFactoryAliasWrites.keys()])
        if (name.startsWith(prefix) && !name.slice(prefix.length).includes('.'))
          members.add(name.slice(prefix.length));
      for (const name of [...descriptorFactoryAliasReferences.keys()])
        if (name.startsWith(prefix) && !name.slice(prefix.length).includes('.'))
          members.add(name.slice(prefix.length));
      for (const member of members) {
        const name = `${owner}.${member}`;
        for (const write of descriptorFactoryAliasWrites.get(name) ?? []) {
          added = true;
          addDescriptorFactoryDescriptorWrites(destinationOwner, member, write);
        }
        for (const target of descriptorFactoryAliasReferences.get(name) ?? []) {
          added = true;
          addDescriptorFactoryDescriptorReferenceWrites(destinationOwner, member, target);
        }
      }
      for (const write of descriptorFactoryDynamicMemberWrites.get(owner) ?? []) {
        added = true;
        addDescriptorFactoryDescriptorWrites(destinationOwner, '*', write);
      }
      for (const target of descriptorFactoryDynamicMemberReferences.get(owner) ?? []) {
        added = true;
        addDescriptorFactoryDescriptorReferenceWrites(destinationOwner, '*', target);
      }
    }
    if (!descriptors && !added)
      addDescriptorFactoryDynamicMemberWrite(destinationOwner, expression);
  };
  const addDescriptorFactoryBindingWrites = (pattern, source) => {
    const currentPattern = unwrapExpression(pattern);
    const currentSource = unwrapExpression(source);
    if (ts.isIdentifier(currentPattern)) {
      addDescriptorFactoryAliasWrite(currentPattern.text, currentSource);
      return;
    }
    if (ts.isArrayBindingPattern(currentPattern) || ts.isArrayLiteralExpression(currentPattern)) {
      const sourceReference = staticDescriptorAliasReferenceKey(currentSource);
      for (const [index, element] of currentPattern.elements.entries()) {
        if (ts.isOmittedExpression(element)) continue;
        const target = ts.isBindingElement(element) ? element.name : element;
        if (ts.isBindingElement(element) && element.dotDotDotToken && ts.isIdentifier(target)) {
          if (ts.isArrayLiteralExpression(currentSource)) {
            for (const [restIndex, value] of currentSource.elements.slice(index).entries())
              if (!ts.isSpreadElement(value))
                addDescriptorFactoryAliasWrite(`${target.text}.${restIndex}`, value);
            descriptorFactoryArrayLengths.set(
              target.text,
              Math.max(0, currentSource.elements.length - index),
            );
          } else if (sourceReference) {
            const sourceLength = descriptorFactoryArrayLengths.get(sourceReference);
            if (Number.isInteger(sourceLength)) {
              for (let restIndex = index; restIndex < sourceLength; restIndex += 1)
                addDescriptorFactoryAliasReference(
                  `${target.text}.${restIndex - index}`,
                  `${sourceReference}.${restIndex}`,
                );
              descriptorFactoryArrayLengths.set(target.text, Math.max(0, sourceLength - index));
            }
          }
          continue;
        }
        const value = ts.isArrayLiteralExpression(currentSource)
          ? currentSource.elements[index]
          : undefined;
        if (value && !ts.isSpreadElement(value)) addDescriptorFactoryBindingWrites(target, value);
        else if (sourceReference && ts.isIdentifier(target))
          addDescriptorFactoryAliasReference(target.text, `${sourceReference}.${index}`);
      }
      return;
    }
    if (ts.isObjectBindingPattern(currentPattern)) {
      const sourceReference = staticDescriptorAliasReferenceKey(currentSource);
      for (const element of currentPattern.elements) {
        if (
          element.dotDotDotToken &&
          ts.isIdentifier(element.name) &&
          ts.isObjectLiteralExpression(currentSource)
        ) {
          addDescriptorFactoryObjectMemberWrites(element.name.text, currentSource);
          continue;
        }
        const keyNode = element.propertyName ?? element.name;
        const key =
          ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) ? keyNode.text : undefined;
        const value = key ? objectLiteralPropertyValue(currentSource, key) : undefined;
        if (value) addDescriptorFactoryBindingWrites(element.name, value);
        else if (key && sourceReference && ts.isIdentifier(element.name))
          addDescriptorFactoryAliasReference(element.name.text, `${sourceReference}.${key}`);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(currentPattern)) {
      const sourceReference = staticDescriptorAliasReferenceKey(currentSource);
      for (const property of currentPattern.properties) {
        const key = staticObjectPropertyName(property.name);
        const target = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isPropertyAssignment(property)
            ? property.initializer
            : undefined;
        const value = key ? objectLiteralPropertyValue(currentSource, key) : undefined;
        if (target && value) addDescriptorFactoryBindingWrites(target, value);
        else if (key && sourceReference && target && ts.isIdentifier(target))
          addDescriptorFactoryAliasReference(target.text, `${sourceReference}.${key}`);
      }
    }
  };
  const addDescriptorFactoryObjectMemberWrites = (owner, object) => {
    if (!ts.isObjectLiteralExpression(object)) return;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = unwrapExpression(property.expression);
        if (ts.isObjectLiteralExpression(spread))
          addDescriptorFactoryObjectMemberWrites(owner, spread);
        else {
          const reference = staticDescriptorAliasReferenceKey(spread);
          if (reference) addDescriptorFactoryObjectSpreadReference(owner, reference);
        }
        continue;
      }
      const key = staticObjectPropertyName(property.name);
      const value = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : ts.isPropertyAssignment(property)
          ? property.initializer
          : undefined;
      if ((!key || key === '*') && value) {
        addDescriptorFactoryDynamicMemberWrite(owner, value);
        continue;
      }
      if (key && key !== '*' && value) {
        const member = `${owner}.${key}`;
        addDescriptorFactoryAliasWrite(member, value);
        addDescriptorFactoryObjectMemberWrites(member, unwrapExpression(value));
        addDescriptorFactoryArrayMemberWrites(member, unwrapExpression(value));
      }
    }
  };
  const addDescriptorFactoryArrayMemberWrites = (owner, array) => {
    if (!ts.isArrayLiteralExpression(array)) {
      const reference = staticDescriptorAliasReferenceKey(array);
      const length = reference ? descriptorFactoryArrayLengths.get(reference) : undefined;
      if (reference && Number.isInteger(length)) {
        for (let index = 0; index < length; index += 1)
          addDescriptorFactoryAliasReference(`${owner}.${index}`, `${reference}.${index}`);
        descriptorFactoryArrayLengths.set(owner, length);
      }
      return;
    }
    let lengthKnown = true;
    const appendElements = (currentArray, startIndex) => {
      let outputIndex = startIndex;
      for (const element of currentArray.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = unwrapExpression(element.expression);
          if (ts.isArrayLiteralExpression(spread)) {
            outputIndex = appendElements(spread, outputIndex);
            continue;
          }
          const reference = staticDescriptorAliasReferenceKey(spread);
          const spreadLength = reference ? descriptorFactoryArrayLengths.get(reference) : undefined;
          if (reference && Number.isInteger(spreadLength)) {
            for (let index = 0; index < spreadLength; index += 1)
              addDescriptorFactoryAliasReference(
                `${owner}.${outputIndex + index}`,
                `${reference}.${index}`,
              );
            outputIndex += spreadLength;
          } else lengthKnown = false;
          continue;
        }
        const member = `${owner}.${outputIndex++}`;
        addDescriptorFactoryAliasWrite(member, element);
        addDescriptorFactoryObjectMemberWrites(member, unwrapExpression(element));
        addDescriptorFactoryArrayMemberWrites(member, unwrapExpression(element));
      }
      return outputIndex;
    };
    const length = appendElements(array, 0);
    if (lengthKnown) descriptorFactoryArrayLengths.set(owner, length);
    else descriptorFactoryArrayLengths.delete(owner);
  };
  const collectDescriptorFactoryAliases = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      addDescriptorFactoryBindingWrites(node.name, node.initializer);
      if (ts.isIdentifier(node.name)) {
        const initializer = unwrapExpression(node.initializer);
        addDescriptorFactoryObjectMemberWrites(node.name.text, initializer);
        addDescriptorFactoryArrayMemberWrites(node.name.text, initializer);
      }
    }
    if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
      ts.isClassDeclaration(node.parent) &&
      node.parent.name
    ) {
      const key = staticObjectPropertyName(node.name);
      if (key && key !== '*')
        addDescriptorFactoryAliasWrite(`${node.parent.name.text}.${key}`, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      const value = node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : node;
      addDescriptorFactoryAliasWrite(node.left.text, value);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const current = unwrapExpression(node.right);
        addDescriptorFactoryObjectMemberWrites(node.left.text, current);
        addDescriptorFactoryArrayMemberWrites(node.left.text, current);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !ts.isIdentifier(node.left)
    ) {
      addDescriptorFactoryBindingWrites(node.left, node.right);
      const member = staticDescriptorAliasReferenceKey(node.left);
      if (member) addDescriptorFactoryAliasWrite(member, node.right);
      else {
        const left = unwrapExpression(node.left);
        if (ts.isElementAccessExpression(left)) {
          const owner = staticDescriptorAliasReferenceKey(left.expression);
          if (owner) addDescriptorFactoryDynamicMemberWrite(owner, node.right);
        }
      }
    }
    if (isMethodCall(node, 'Reflect', 'set')) {
      const [target, key, value] = methodCallArguments(node, 'Reflect', 'set');
      const owner = target ? staticDescriptorAliasReferenceKey(target) : undefined;
      const member = key ? staticMemberKey(key) : '*';
      if (owner && value) {
        if (member === '*') addDescriptorFactoryDynamicMemberWrite(owner, value);
        else addDescriptorFactoryAliasWrite(`${owner}.${member}`, value);
      }
    }
    if (isMethodCall(node, 'Object', 'assign')) {
      const [target, ...sources] = methodCallArguments(node, 'Object', 'assign') ?? [];
      const owner = target ? staticDescriptorAliasReferenceKey(target) : undefined;
      if (owner)
        for (const source of sources) {
          const current = unwrapExpression(source);
          if (ts.isObjectLiteralExpression(current))
            addDescriptorFactoryObjectMemberWrites(owner, current);
          else {
            const reference = staticDescriptorAliasReferenceKey(current);
            if (reference) addDescriptorFactoryObjectSpreadReference(owner, reference);
          }
        }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const owner = staticDescriptorAliasReferenceKey(callee.expression);
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : callee.argumentExpression
            ? staticMemberKey(callee.argumentExpression)
            : '*';
        if (owner && (method === 'push' || method === 'unshift'))
          for (const value of node.arguments) addDescriptorFactoryDynamicMemberWrite(owner, value);
        if (owner && method === 'splice')
          for (const value of [...node.arguments].slice(2))
            addDescriptorFactoryDynamicMemberWrite(owner, value);
        if (method === 'call' || method === 'apply') {
          const prototypeTarget = staticDescriptorAliasReferenceKey(callee.expression);
          const match = prototypeTarget?.match(/^Array\.prototype\.(push|unshift|splice)$/u);
          const mutationOwner = node.arguments[0]
            ? staticDescriptorAliasReferenceKey(node.arguments[0])
            : undefined;
          if (match && mutationOwner) {
            const mutation = match[1];
            if (method === 'call') {
              const values = [...node.arguments].slice(mutation === 'splice' ? 3 : 1);
              for (const value of values)
                addDescriptorFactoryDynamicMemberWrite(mutationOwner, value);
            } else if (node.arguments[1]) {
              const staticArrayEntries = (expression) => {
                const current = unwrapExpression(expression);
                if (ts.isArrayLiteralExpression(current)) {
                  const entries = [];
                  for (const element of current.elements) {
                    if (!ts.isSpreadElement(element)) {
                      entries.push({ expression: element });
                      continue;
                    }
                    const spreadEntries = staticArrayEntries(element.expression, visited);
                    if (!spreadEntries) return undefined;
                    entries.push(...spreadEntries);
                  }
                  return entries;
                }
                const reference = staticDescriptorAliasReferenceKey(current);
                const length = reference ? descriptorFactoryArrayLengths.get(reference) : undefined;
                if (!reference || !Number.isInteger(length) || visited.has(reference))
                  return undefined;
                return Array.from({ length }, (_, index) => {
                  const member = `${reference}.${index}`;
                  const writes = descriptorFactoryAliasWrites.get(member) ?? [];
                  if (writes.length === 1) return { expression: writes[0] };
                  const references = descriptorFactoryAliasReferences.get(member) ?? [];
                  if (writes.length === 0 && references.length === 1)
                    return { reference: references[0] };
                  return { reference: member };
                });
              };
              const applied = node.arguments[1];
              const entries = staticArrayEntries(applied);
              if (!entries) addDescriptorFactoryDynamicMemberWrite(mutationOwner, applied);
              else
                for (const entry of entries.slice(mutation === 'splice' ? 2 : 0)) {
                  if (entry.expression)
                    addDescriptorFactoryDynamicMemberWrite(mutationOwner, entry.expression);
                  else if (entry.reference)
                    addDescriptorFactoryDynamicMemberReference(mutationOwner, entry.reference);
                }
            }
          }
        }
      }
    }
    for (const ownerName of ['Reflect', 'Object']) {
      if (!isMethodCall(node, ownerName, 'defineProperty')) continue;
      const [target, key, descriptor] = methodCallArguments(node, ownerName, 'defineProperty');
      const owner = target ? staticDescriptorAliasReferenceKey(target) : undefined;
      const member = key ? staticMemberKey(key) : '*';
      if (!owner || !descriptor) continue;
      addDescriptorFactoryDescriptorWrites(owner, member, descriptor);
    }
    if (isMethodCall(node, 'Object', 'defineProperties')) {
      const [target, descriptors] = methodCallArguments(node, 'Object', 'defineProperties');
      const owner = target ? staticDescriptorAliasReferenceKey(target) : undefined;
      if (owner && descriptors) addDescriptorFactoryDescriptorsMapWrites(owner, descriptors);
    }
    ts.forEachChild(node, collectDescriptorFactoryAliases);
  };
  collectDescriptorFactoryAliases(sourceFile);
  const descriptorFactoryDynamicWritesForOwner = (owner) =>
    [...descriptorFactoryOwnerClosure(owner)].flatMap(
      (candidate) => descriptorFactoryDynamicMemberWrites.get(candidate) ?? [],
    );
  const descriptorFactoryDynamicReferencesForOwner = (owner) =>
    [...descriptorFactoryOwnerClosure(owner)].flatMap(
      (candidate) => descriptorFactoryDynamicMemberReferences.get(candidate) ?? [],
    );
  let resolveDescriptorFactoryName;
  const resolveDescriptorFactoryReturnName = (name, visited = new Set()) => {
    if (descriptorFactoryReturnValues.has(name)) return name;
    if (visited.has(name)) return undefined;
    const writes = descriptorFactoryAliasWrites.get(name) ?? [];
    const references = descriptorFactoryAliasReferences.get(name) ?? [];
    const candidates = references.concat(
      writes
        .map((write) => staticDescriptorAliasReferenceKey(write))
        .filter((reference) => reference),
    );
    const resolved = new Set();
    const nextVisited = new Set(visited).add(name);
    for (const candidate of candidates) {
      const target = resolveDescriptorFactoryReturnName(candidate, nextVisited);
      if (target) resolved.add(target);
    }
    if (resolved.size === 0) return undefined;
    if (candidates.length !== 1 || resolved.size !== 1)
      throw new Error(`descriptor wrapper returning function ${name} cannot be proven statically`);
    return [...resolved][0];
  };
  const returnedDescriptorFactoryExpression = (call, visited = new Set()) => {
    const current = unwrapExpression(call);
    if (!ts.isCallExpression(current)) return undefined;
    let calledName = staticDescriptorAliasReferenceKey(current.expression);
    if (!calledName && ts.isCallExpression(unwrapExpression(current.expression))) {
      const returnedCallee = returnedDescriptorFactoryExpression(current.expression, visited);
      calledName = returnedCallee ? staticDescriptorAliasReferenceKey(returnedCallee) : undefined;
    }
    if (!calledName || visited.has(`return:${calledName}`)) return undefined;
    const returnName = resolveDescriptorFactoryReturnName(calledName);
    return returnName ? descriptorFactoryReturnValues.get(returnName) : undefined;
  };
  const resolveDescriptorFactoryExpression = (expression, visited = new Set()) => {
    const current = unwrapExpression(expression);
    const reference = staticDescriptorAliasReferenceKey(current);
    if (reference) return resolveDescriptorFactoryName(reference, visited);
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      const owner = staticDescriptorAliasReferenceKey(current.expression);
      const dynamicWrites = owner ? descriptorFactoryDynamicWritesForOwner(owner) : [];
      const dynamicReferences = owner ? descriptorFactoryDynamicReferencesForOwner(owner) : [];
      if (
        dynamicWrites.some((write) => resolveDescriptorFactoryExpression(write, visited)) ||
        dynamicReferences.some((target) => resolveDescriptorFactoryName(target, visited))
      )
        throw new Error(`descriptor wrapper dynamic member ${owner} cannot be proven statically`);
    }
    if (!ts.isCallExpression(current)) return undefined;
    const returned = returnedDescriptorFactoryExpression(current, visited);
    if (!returned) return undefined;
    return resolveDescriptorFactoryExpression(returned, new Set(visited).add('return:call'));
  };
  resolveDescriptorFactoryName = (name, visited = new Set()) => {
    // 文件没有 descriptor factory 时，普通变量的别名图不可能解析出 factory。
    if (descriptorFactories.size === 0 && unprovenDescriptorFactories.size === 0) return undefined;
    if (descriptorFactories.has(name) || unprovenDescriptorFactories.has(name)) return name;
    if (visited.has(name)) return undefined;
    const writes = descriptorFactoryAliasWrites.get(name) ?? [];
    const references = descriptorFactoryAliasReferences.get(name) ?? [];
    const nextVisited = new Set(visited).add(name);
    if (writes.length === 0 && references.length === 0) {
      const separator = name.lastIndexOf('.');
      if (separator < 0) return undefined;
      const owner = name.slice(0, separator);
      const member = name.slice(separator + 1);
      const ownerWrites = descriptorFactoryAliasWrites.get(owner) ?? [];
      const ownerReferences = descriptorFactoryAliasReferences.get(owner) ?? [];
      const ownerTargets = [
        ...ownerReferences,
        ...ownerWrites
          .map((write) => staticDescriptorAliasReferenceKey(write))
          .filter((reference) => reference),
      ];
      const spreadTargets = descriptorFactoryObjectSpreadReferences.get(owner) ?? [];
      const resolvedMembers = new Set();
      for (const target of ownerTargets.concat(spreadTargets)) {
        const resolved = resolveDescriptorFactoryName(`${target}.${member}`, nextVisited);
        if (resolved) resolvedMembers.add(resolved);
      }
      if (resolvedMembers.size === 0) return undefined;
      if (ownerTargets.length + spreadTargets.length !== 1 || resolvedMembers.size !== 1)
        throw new Error(`descriptor wrapper alias ${name} cannot be proven statically`);
      return [...resolvedMembers][0];
    }
    const resolved = new Set();
    let ambiguous = writes.length + references.length !== 1;
    for (const reference of references) {
      const target = resolveDescriptorFactoryName(reference, nextVisited);
      if (target) resolved.add(target);
    }
    for (const write of writes) {
      const directTarget = resolveDescriptorFactoryExpression(write, nextVisited);
      if (directTarget) {
        resolved.add(directTarget);
        continue;
      }
      const referencedFactories = new Set();
      const visit = (node) => {
        if (ts.isIdentifier(node)) {
          const target = resolveDescriptorFactoryName(node.text, nextVisited);
          if (target) referencedFactories.add(target);
        }
        ts.forEachChild(node, visit);
      };
      visit(write);
      if (referencedFactories.size > 0) {
        ambiguous = true;
        for (const target of referencedFactories) resolved.add(target);
      }
    }
    if (resolved.size === 0) return undefined;
    if (ambiguous || resolved.size !== 1)
      throw new Error(`descriptor wrapper alias ${name} cannot be proven statically`);
    return [...resolved][0];
  };
  const expressionReferencesDescriptorFactory = (expression) => {
    let referenced = false;
    const visit = (node) => {
      if (referenced) return;
      if (ts.isIdentifier(node) && resolveDescriptorFactoryName(node.text)) {
        referenced = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return referenced;
  };
  const descriptorFactoryCall = (node, kind) => {
    const current = unwrapExpression(node);
    if (!ts.isCallExpression(current)) return undefined;
    let calledName = staticDescriptorAliasReferenceKey(current.expression);
    let callArguments = [...current.arguments];
    let name = calledName ? resolveDescriptorFactoryName(calledName) : undefined;
    if (!name) {
      name = resolveDescriptorFactoryExpression(current.expression);
      if (name) calledName = name;
    }
    const invokedCallee = unwrapExpression(current.expression);
    if (
      !name &&
      (ts.isPropertyAccessExpression(invokedCallee) || ts.isElementAccessExpression(invokedCallee))
    ) {
      const invocation = ts.isPropertyAccessExpression(invokedCallee)
        ? invokedCallee.name.text
        : invokedCallee.argumentExpression
          ? staticMemberKey(invokedCallee.argumentExpression)
          : '*';
      if (invocation === 'call' || invocation === 'apply') {
        calledName = staticDescriptorAliasReferenceKey(invokedCallee.expression);
        name = calledName ? resolveDescriptorFactoryName(calledName) : undefined;
        if (name && invocation === 'call') callArguments = [...current.arguments].slice(1);
        if (name && invocation === 'apply') {
          const applied = current.arguments[1] && unwrapExpression(current.arguments[1]);
          if (
            !applied ||
            !ts.isArrayLiteralExpression(applied) ||
            applied.elements.some(ts.isSpreadElement)
          )
            throw new Error(
              `descriptor wrapper ${calledName}.apply arguments cannot be proven statically`,
            );
          callArguments = [...applied.elements];
        }
      }
    }
    if (!name && ts.isCallExpression(invokedCallee)) {
      const boundCallee = unwrapExpression(invokedCallee.expression);
      if (
        (ts.isPropertyAccessExpression(boundCallee) || ts.isElementAccessExpression(boundCallee)) &&
        (ts.isPropertyAccessExpression(boundCallee)
          ? boundCallee.name.text
          : boundCallee.argumentExpression
            ? staticMemberKey(boundCallee.argumentExpression)
            : '*') === 'bind'
      ) {
        calledName = staticDescriptorAliasReferenceKey(boundCallee.expression);
        name = calledName ? resolveDescriptorFactoryName(calledName) : undefined;
        if (name)
          callArguments = [...invokedCallee.arguments].slice(1).concat([...current.arguments]);
      }
    }
    if (!name && ts.isElementAccessExpression(invokedCallee)) {
      const owner = staticDescriptorAliasReferenceKey(invokedCallee.expression);
      const dynamicWrites = owner ? descriptorFactoryDynamicWritesForOwner(owner) : [];
      const dynamicReferences = owner ? descriptorFactoryDynamicReferencesForOwner(owner) : [];
      if (
        dynamicWrites.some(expressionReferencesDescriptorFactory) ||
        dynamicReferences.some((target) => resolveDescriptorFactoryName(target))
      )
        throw new Error(`descriptor wrapper dynamic member ${owner} cannot be proven statically`);
    }
    if (!name && current.arguments.some(expressionReferencesDescriptorFactory))
      throw new Error('descriptor wrapper callback target cannot be proven statically');
    if (!calledName || !name) return undefined;
    if (unprovenDescriptorFactories.has(name))
      throw new Error(`descriptor wrapper ${calledName} cannot be proven statically`);
    const factory = descriptorFactories.get(name);
    return factory?.kind === kind ? { call: { arguments: callArguments }, factory } : undefined;
  };
  const resolveFactoryValue = ({ call, factory }, value) => {
    let current = unwrapExpression(value);
    const visited = new Set();
    while (ts.isIdentifier(current)) {
      if (visited.has(current.text)) return undefined;
      visited.add(current.text);
      if (factory.ambiguousLocalValues.has(current.text))
        throw new Error(`descriptor wrapper alias ${current.text} cannot be proven statically`);
      const parameterIndex = factory.parameters.indexOf(current.text);
      if (parameterIndex >= 0) return call.arguments[parameterIndex];
      const localValue = factory.localValues.get(current.text);
      if (!localValue) return current;
      current = unwrapExpression(localValue);
    }
    let containsFactoryBinding = false;
    const visit = (node) => {
      if (ts.isIdentifier(node) && factory.parameterBindingNames.has(node.text)) {
        containsFactoryBinding = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(current);
    if (containsFactoryBinding)
      throw new Error('descriptor wrapper expression cannot be proven statically');
    return current;
  };
  const descriptorContainerTarget = (node) => {
    const current = unwrapExpression(node);
    if (isMethodCall(current, 'Object', 'getOwnPropertyDescriptors'))
      return methodCallArguments(current, 'Object', 'getOwnPropertyDescriptors')?.[0];
    const factoryCall = descriptorFactoryCall(current, 'container');
    return factoryCall ? resolveFactoryValue(factoryCall, factoryCall.factory.target) : undefined;
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
    const factoryCall = descriptorFactoryCall(current, 'member');
    if (factoryCall) {
      const target = resolveFactoryValue(factoryCall, factoryCall.factory.target);
      const key = resolveFactoryValue(factoryCall, factoryCall.factory.key);
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
    // 动态成员已经表示任意路径；继续拼接会在别名环中无限生成 *.*。
    if (member.split('.').includes('*')) member = '*';
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
    if (ts.canHaveDecorators(node)) {
      for (const decorator of ts.getDecorators(node) ?? [])
        collectCallableReference(decorator.expression);
    }
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

  // Preserve decorator, class, and object member-qualified callable requests until import resolution.
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
  const visitLiteralDynamicImports = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      RELATIVE_MODULE_SPECIFIER.test(node.arguments[0].text)
    )
      dependencies.push({
        specifier: node.arguments[0].text,
        bindings: new Set(['*']),
        callableBindings: new Set(['*']),
        sideEffect: true,
      });
    ts.forEachChild(node, visitLiteralDynamicImports);
  };
  visitLiteralDynamicImports(sourceFile);

  const unwrapResourceExpression = (node) => {
    let current = node;
    while (true) {
      if (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
      ) {
        current = current.expression;
        continue;
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        current = current.right;
        continue;
      }
      return current;
    }
  };
  const readFileNames = new Set();
  const fsObjectNames = new Set();
  const readMethodNames = new Set(['readFile', 'readFileSync']);
  const fsModuleNames = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !fsModuleNames.has(statement.moduleSpecifier.text) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    )
      continue;
    const moduleName = statement.moduleSpecifier.text;
    if (statement.importClause.name) fsObjectNames.add(statement.importClause.name.text);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) fsObjectNames.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (readMethodNames.has(importedName)) readFileNames.add(element.name.text);
        if (importedName === 'promises' && ['fs', 'node:fs'].includes(moduleName))
          fsObjectNames.add(element.name.text);
      }
  }
  const bindingNameCounts = new Map();
  const addBindingName = (name) => {
    bindingNameCounts.set(name, (bindingNameCounts.get(name) ?? 0) + 1);
  };
  const collectBindingNames = (name) => {
    if (ts.isIdentifier(name)) addBindingName(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const element of name.elements)
        if (ts.isBindingElement(element)) collectBindingNames(element.name);
  };
  const visitBindingNames = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) collectBindingNames(node.name);
    else if (ts.isImportClause(node) && node.name) addBindingName(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
      addBindingName(node.name.text);
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name
    )
      addBindingName(node.name.text);
    ts.forEachChild(node, visitBindingNames);
  };
  visitBindingNames(sourceFile);
  const staticStringInitializers = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      staticStringInitializers.set(declaration.name.text, declaration.initializer);
    }
  }
  const staticStringValue = (node, seen = new Set()) => {
    const current = unwrapResourceExpression(node);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      return current.text;
    if (
      !ts.isIdentifier(current) ||
      seen.has(current.text) ||
      bindingNameCounts.get(current.text) !== 1
    )
      return undefined;
    const initializer = staticStringInitializers.get(current.text);
    if (!initializer) return undefined;
    return staticStringValue(initializer, new Set([...seen, current.text]));
  };
  const staticPropertyName = (node) => {
    const current = unwrapResourceExpression(node);
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (ts.isElementAccessExpression(current) && current.argumentExpression)
      return staticStringValue(current.argumentExpression);
    return undefined;
  };
  const staticBindingPropertyName = (element) => {
    const propertyName = element.propertyName ?? element.name;
    if (ts.isComputedPropertyName(propertyName)) return staticStringValue(propertyName.expression);
    return ts.isIdentifier(propertyName) ||
      ts.isStringLiteral(propertyName) ||
      ts.isNoSubstitutionTemplateLiteral(propertyName)
      ? propertyName.text
      : undefined;
  };
  const staticAssignmentPropertyName = (property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      return undefined;
    const propertyName = property.name;
    if (ts.isComputedPropertyName(propertyName)) return staticStringValue(propertyName.expression);
    return ts.isIdentifier(propertyName) ||
      ts.isStringLiteral(propertyName) ||
      ts.isNoSubstitutionTemplateLiteral(propertyName)
      ? propertyName.text
      : undefined;
  };
  const assignmentTargetName = (node) => {
    const current = unwrapExpression(node);
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(current.left)
    )
      return current.left.text;
    return undefined;
  };
  const assignmentPropertyTargetName = (property) => {
    if (ts.isPropertyAssignment(property)) return assignmentTargetName(property.initializer);
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
    return undefined;
  };
  const propertyOwner = (node) => {
    const current = unwrapResourceExpression(node);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      return unwrapResourceExpression(current.expression);
    return undefined;
  };
  const isFsObjectExpression = (node) => {
    const current = unwrapResourceExpression(node);
    if (ts.isIdentifier(current)) return fsObjectNames.has(current.text);
    if (ts.isConditionalExpression(current))
      return isFsObjectExpression(current.whenTrue) || isFsObjectExpression(current.whenFalse);
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    )
      return isFsObjectExpression(current.left) || isFsObjectExpression(current.right);
    const owner = propertyOwner(current);
    return (
      staticPropertyName(current) === 'promises' &&
      owner !== undefined &&
      isFsObjectExpression(owner)
    );
  };
  const isFsReadExpression = (node) => {
    const current = unwrapResourceExpression(node);
    if (ts.isIdentifier(current)) return readFileNames.has(current.text);
    const owner = propertyOwner(current);
    return (
      readMethodNames.has(staticPropertyName(current)) &&
      owner !== undefined &&
      isFsObjectExpression(owner)
    );
  };
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    const addAlias = (set, name) => {
      if (!set.has(name)) {
        set.add(name);
        aliasesChanged = true;
      }
    };
    const classifyAlias = (name, initializer) => {
      if (isFsObjectExpression(initializer)) addAlias(fsObjectNames, name);
      if (isFsReadExpression(initializer)) addAlias(readFileNames, name);
    };
    const visitAliases = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) classifyAlias(node.name.text, node.initializer);
        if (ts.isObjectBindingPattern(node.name) && isFsObjectExpression(node.initializer))
          for (const element of node.name.elements) {
            const importedName = staticBindingPropertyName(element);
            if (!ts.isIdentifier(element.name)) continue;
            if (importedName && readMethodNames.has(importedName))
              addAlias(readFileNames, element.name.text);
            if (importedName === 'promises') addAlias(fsObjectNames, element.name.text);
          }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left)) classifyAlias(node.left.text, node.right);
        if (ts.isObjectLiteralExpression(node.left) && isFsObjectExpression(node.right))
          for (const property of node.left.properties) {
            const importedName = staticAssignmentPropertyName(property);
            const targetName = assignmentPropertyTargetName(property);
            if (!importedName || !targetName) continue;
            if (readMethodNames.has(importedName)) addAlias(readFileNames, targetName);
            if (importedName === 'promises') addAlias(fsObjectNames, targetName);
          }
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sourceFile);
  }
  const isImportMetaUrl = (node) => {
    const current = unwrapResourceExpression(node);
    return (
      ts.isPropertyAccessExpression(current) &&
      current.name.text === 'url' &&
      ts.isMetaProperty(current.expression) &&
      current.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      current.expression.name.text === 'meta'
    );
  };
  const staticModuleRelativeUrl = (node) => {
    const current = unwrapResourceExpression(node);
    if (
      !ts.isNewExpression(current) ||
      !ts.isIdentifier(current.expression) ||
      current.expression.text !== 'URL' ||
      current.arguments?.length !== 2 ||
      !isImportMetaUrl(current.arguments[1])
    )
      return undefined;
    const specifier = unwrapExpression(current.arguments[0]);
    return (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
      RELATIVE_MODULE_SPECIFIER.test(specifier.text)
      ? specifier.text
      : undefined;
  };
  const staticReadFileSpecifier = (node) => {
    const current = unwrapResourceExpression(node);
    const direct = staticModuleRelativeUrl(current);
    if (direct) return direct;
    if (ts.isCallExpression(current) && current.arguments[0])
      return staticModuleRelativeUrl(current.arguments[0]);
    return undefined;
  };
  const directInvocationMethodNames = new Set(['call', 'apply']);
  const topLevelCalledIdentifiers = new Set();
  const visitTopLevelCalls = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrapResourceExpression(node.expression);
      if (ts.isIdentifier(callee)) topLevelCalledIdentifiers.add(callee.text);
      const owner = propertyOwner(callee);
      if (
        owner &&
        ts.isIdentifier(owner) &&
        directInvocationMethodNames.has(staticPropertyName(callee))
      )
        topLevelCalledIdentifiers.add(owner.text);
    }
    ts.forEachChild(node, visitTopLevelCalls);
  };
  for (const statement of sourceFile.statements) visitTopLevelCalls(statement);
  const enclosingFunction = (node) => {
    let scope = node.parent;
    while (scope && scope !== sourceFile) {
      if (ts.isFunctionLike(scope)) return scope;
      scope = scope.parent;
    }
    return undefined;
  };
  const outerFunctionExpression = (scope) => {
    let wrapped = scope;
    while (
      wrapped.parent &&
      (ts.isParenthesizedExpression(wrapped.parent) ||
        ts.isAsExpression(wrapped.parent) ||
        ts.isTypeAssertionExpression(wrapped.parent) ||
        ts.isNonNullExpression(wrapped.parent) ||
        ts.isSatisfiesExpression(wrapped.parent) ||
        (ts.isBinaryExpression(wrapped.parent) &&
          wrapped.parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
          wrapped.parent.right === wrapped))
    )
      wrapped = wrapped.parent;
    return wrapped;
  };
  const functionBindingName = (scope) => {
    if (scope.name && ts.isIdentifier(scope.name)) return scope.name.text;
    const parent = outerFunctionExpression(scope).parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(parent.left)
    )
      return parent.left.text;
    return undefined;
  };
  const isImmediatelyInvokedFunction = (scope) => {
    const wrapped = outerFunctionExpression(scope);
    if (
      wrapped.parent &&
      ts.isCallExpression(wrapped.parent) &&
      unwrapResourceExpression(wrapped.parent.expression) === scope
    )
      return true;
    const member = wrapped.parent;
    return Boolean(
      member &&
      (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
      directInvocationMethodNames.has(staticPropertyName(member)) &&
      member.parent &&
      ts.isCallExpression(member.parent) &&
      unwrapResourceExpression(member.parent.expression) === member,
    );
  };
  const mustFailUnprovenFsAccess = (node) => {
    const scope = enclosingFunction(node);
    if (!scope) return true;
    const bindingName = functionBindingName(scope);
    return (
      isImmediatelyInvokedFunction(scope) ||
      (bindingName !== undefined && topLevelCalledIdentifiers.has(bindingName))
    );
  };
  const visitResourceReads = (node) => {
    if (ts.isElementAccessExpression(node)) {
      const owner = propertyOwner(node);
      if (
        owner !== undefined &&
        isFsObjectExpression(owner) &&
        staticPropertyName(node) === undefined &&
        mustFailUnprovenFsAccess(node)
      )
        throw new Error(`Migration dependency ${path} accesses an unproven dynamic fs member`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isFsObjectExpression(node.initializer) &&
      mustFailUnprovenFsAccess(node) &&
      node.name.elements.some(
        (element) =>
          element.propertyName &&
          ts.isComputedPropertyName(element.propertyName) &&
          staticBindingPropertyName(element) === undefined,
      )
    )
      throw new Error(`Migration dependency ${path} accesses an unproven dynamic fs member`);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(node.left) &&
      isFsObjectExpression(node.right) &&
      mustFailUnprovenFsAccess(node) &&
      node.left.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          ts.isComputedPropertyName(property.name) &&
          staticAssignmentPropertyName(property) === undefined,
      )
    )
      throw new Error(`Migration dependency ${path} accesses an unproven dynamic fs member`);
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (isFsReadExpression(callee)) {
        const specifier = node.arguments[0] && staticReadFileSpecifier(node.arguments[0]);
        if (!specifier && mustFailUnprovenFsAccess(node))
          throw new Error(`Migration dependency ${path} reads an unproven dynamic resource path`);
        if (specifier)
          dependencies.push({
            specifier,
            bindings: new Set(['*']),
            callableBindings: new Set(),
            sideEffect: true,
          });
      }
    }
    ts.forEachChild(node, visitResourceReads);
  };
  if (isMigrationPath(path)) visitResourceReads(sourceFile);
  return dependencies;
}

function hasUnprovenRuntimeModuleLoad(content, path, repositoryPaths) {
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

  const isLoaderExpression = (expression) =>
    ts.isIdentifier(expression) && loaderNames.has(expression.text);
  const containsLoaderReference = (expression) => {
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (ts.isIdentifier(node) && loaderNames.has(node.text)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
  };
  let unprovenLoaderPropagation = false;
  const visitLoaderPropagation = (node) => {
    if (unprovenLoaderPropagation) return;
    if (
      (ts.isPropertyAssignment(node) && containsLoaderReference(node.initializer)) ||
      (ts.isShorthandPropertyAssignment(node) && loaderNames.has(node.name.text)) ||
      (ts.isSpreadAssignment(node) && containsLoaderReference(node.expression)) ||
      (ts.isArrayLiteralExpression(node) && node.elements.some(containsLoaderReference)) ||
      (ts.isReturnStatement(node) && node.expression && containsLoaderReference(node.expression)) ||
      (ts.isCallExpression(node) && node.arguments.some(containsLoaderReference)) ||
      (ts.isVariableDeclaration(node) &&
        node.initializer &&
        !isLoaderExpression(node.initializer) &&
        containsLoaderReference(node.initializer)) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (!ts.isIdentifier(node.left) || !isLoaderExpression(node.right)) &&
        containsLoaderReference(node.right))
    ) {
      unprovenLoaderPropagation = true;
      return;
    }
    ts.forEachChild(node, visitLoaderPropagation);
  };
  visitLoaderPropagation(sourceFile);
  if (unprovenLoaderPropagation) return true;

  let found = false;
  const visit = (node) => {
    if (found) return;
    const provenLiteralDynamicImport =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      RELATIVE_MODULE_SPECIFIER.test(node.arguments[0].text) &&
      repositoryPaths instanceof Set &&
      resolveRepositoryModule(path, node.arguments[0].text, repositoryPaths) !== null;
    if (
      ts.isCallExpression(node) &&
      !provenLiteralDynamicImport &&
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

  return sourceFile.statements.some(isTopLevelExecutableStatement);
}

// 顶层语句是否会在 import 时执行代码。从 hasTopLevelExecutableCode 里原样抽出，
// 以便按「变更行触碰到的顶层语句」做同一套判定。
function isTopLevelExecutableStatement(statement) {
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

// Batch input is NUL-delimited so repository filenames cannot add synthetic object queries.
function createRepositorySnapshot(execFileSync, cwd, sha) {
  const repositoryPaths = new Set(
    pathsFromTree(gitRead(execFileSync, cwd, ['ls-tree', '-r', '--name-only', '-z', sha, '--'])),
  );
  const contents = new Map();
  const batchPaths = [...repositoryPaths].filter((path) =>
    /\.(?:[cm]?[jt]s|json|sql)$/iu.test(path),
  );
  try {
    const output = execFileSync('git', ['cat-file', '--batch', '-z'], {
      cwd,
      input: `${batchPaths.map((path) => `${sha}:${path}`).join('\0')}\0`,
      maxBuffer: 256 * 1024 * 1024,
    });
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    let offset = 0;
    for (const path of batchPaths) {
      const headerEnd = buffer.indexOf(10, offset);
      if (headerEnd < 0) throw new Error('truncated git cat-file header');
      const header = buffer.subarray(offset, headerEnd).toString('utf8');
      const match = /^[a-f0-9]+ blob ([0-9]+)$/u.exec(header);
      if (!match) throw new Error(`unexpected git cat-file response for ${path}`);
      const size = Number(match[1]);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (!Number.isSafeInteger(size) || buffer[contentEnd] !== 10)
        throw new Error(`truncated git cat-file object for ${path}`);
      contents.set(path, buffer.subarray(contentStart, contentEnd).toString('utf8'));
      offset = contentEnd + 1;
    }
  } catch {
    // Test doubles or older Git builds may not expose NUL-input batch mode.
  }
  return {
    repositoryPaths,
    read(path) {
      if (!contents.has(path))
        contents.set(path, gitRead(execFileSync, cwd, ['show', `${sha}:${path}`]));
      return contents.get(path);
    },
  };
}

// Traverse every authority dependency before diff pruning so unresolved runtime loaders fail closed.
function authorityRootsIntersectingDiff(snapshot, candidatePaths) {
  const candidateSet = new Set(candidatePaths);
  const dependenciesByPath = new Map();
  const dependenciesFor = (path) => {
    if (dependenciesByPath.has(path)) return dependenciesByPath.get(path);
    if (!SCRIPT_MIGRATION_PATTERN.test(path)) {
      dependenciesByPath.set(path, []);
      return [];
    }
    const content = snapshot.read(path);
    const sourceFile = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if ((sourceFile.parseDiagnostics ?? []).length > 0)
      throw new Error(`Migration dependency ${path} is not valid TypeScript`);
    const specifiers = new Set();
    const inspectLoaderArguments = /\b(?:require|createRequire)\b|\bimport\s*\(/u.test(content);
    const constantStrings = new Map();
    const unwrapStatic = (node) => {
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
    const staticStrings = (node) => {
      const current = unwrapStatic(node);
      if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
        return [current.text];
      if (ts.isIdentifier(current)) return constantStrings.get(current.text) ?? [];
      if (ts.isConditionalExpression(current))
        return [...staticStrings(current.whenTrue), ...staticStrings(current.whenFalse)];
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = staticStrings(current.left);
        const right = staticStrings(current.right);
        return left.flatMap((prefix) => right.map((suffix) => `${prefix}${suffix}`));
      }
      return [];
    };
    for (const statement of sourceFile.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0
      )
        continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const values = staticStrings(declaration.initializer);
          if (values.length > 0) constantStrings.set(declaration.name.text, values);
        }
    }
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        !node.isTypeOnly &&
        !node.importClause?.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        RELATIVE_MODULE_SPECIFIER.test(node.moduleSpecifier.text)
      )
        specifiers.add(node.moduleSpecifier.text);
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'URL' &&
        node.arguments?.[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
        RELATIVE_MODULE_SPECIFIER.test(node.arguments[0].text)
      )
        specifiers.add(node.arguments[0].text);
      if (inspectLoaderArguments && ts.isCallExpression(node))
        for (const argument of node.arguments)
          for (const value of staticStrings(argument))
            if (RELATIVE_MODULE_SPECIFIER.test(value)) specifiers.add(value);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const dependencies = [...specifiers]
      .map((specifier) => resolveRepositoryModule(path, specifier, snapshot.repositoryPaths))
      .filter(Boolean);
    dependenciesByPath.set(path, dependencies);
    return dependencies;
  };

  const roots = new Set();
  for (const root of PRODUCTION_STARTUP_SCHEMA_ROOTS) {
    if (!snapshot.repositoryPaths.has(root)) continue;
    const visited = new Set();
    const queue = [root];
    let intersects = false;
    while (queue.length > 0) {
      const path = queue.shift();
      if (!path || visited.has(path)) continue;
      visited.add(path);
      const content = snapshot.read(path);
      if (hasUnprovenRuntimeModuleLoad(content, path, snapshot.repositoryPaths))
        throw new Error(`Migration dependency ${path} uses dynamic import or require`);
      if (candidateSet.has(path)) intersects = true;
      for (const dependency of dependenciesFor(path)) queue.push(dependency);
    }
    if (intersects) roots.add(root);
  }
  return roots;
}

function buildMigrationDependencyClosure(
  execFileSync,
  cwd,
  sha,
  snapshot,
  additionalRoots = new Set(),
) {
  const { repositoryPaths } = snapshot;
  const roots = [...repositoryPaths]
    .filter((path) => isMigrationPath(path) || additionalRoots.has(path))
    .sort();
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
    const content = snapshot.read(path);
    if (hasUnprovenRuntimeModuleLoad(content, path, repositoryPaths))
      throw new Error(`Migration dependency ${path} uses dynamic import or require`);
    const migrationExecutionModule = isMigrationExecutionModule(path, content);
    const requestedCallableExport = hasRequestedCallableExport(
      path,
      content,
      requestedCallableBindings,
    );
    const topLevelExecutable =
      sideEffectPaths.has(path) && hasTopLevelExecutableCode(path, content);
    const declarativeSqlProvider = isDeclarativeSqlProvider(path, content, requestedBindings);
    if (
      migrationExecutionModule ||
      requestedCallableExport ||
      topLevelExecutable ||
      declarativeSqlProvider
    )
      closure.add(path);
    if (!SCRIPT_MIGRATION_PATTERN.test(path)) {
      closure.add(path);
      continue;
    }
    const dependencyRequests = relativeModuleDependencies(
      content,
      path,
      requestedBindings,
      requestedCallableBindings,
    );
    for (const dependencyRequest of dependencyRequests) {
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
  if (value.includes('\0')) {
    const fields = value.split('\0');
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (!status) continue;
      const path = fields[index++];
      if (path === undefined) break;
      paths.push(path);
      if (/^[RC]/u.test(status)) {
        const targetPath = fields[index++];
        if (targetPath === undefined) break;
        paths.push(targetPath);
      }
    }
    return paths;
  }
  // Injected test doubles may still return the human-readable form.
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [status, ...fields] = line.split('\t');
    if (!status || fields.length === 0) continue;
    if (/^[RC]/u.test(status) && fields.length >= 2) paths.push(fields[0], fields[1]);
    else paths.push(fields[0]);
  }
  return paths;
}

function pathsFromTree(value) {
  return value.split(value.includes('\0') ? '\0' : /\r?\n/u).filter(Boolean);
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
  const snapshots = new Map();
  const snapshotFor = (sha) => {
    if (!snapshots.has(sha)) snapshots.set(sha, createRepositorySnapshot(execFileSync, cwd, sha));
    return snapshots.get(sha);
  };
  try {
    candidatePaths.push(
      ...pathsFromNameStatus(
        gitRead(execFileSync, cwd, [
          'diff',
          '--name-status',
          '--find-renames',
          '-z',
          baseline,
          target,
          '--',
        ]),
      ),
    );
    candidatePaths = [...new Set(candidatePaths)];
    const startupSchemaRoots = (sha) => {
      const snapshot = snapshotFor(sha);
      // Dynamic loader edges cannot be intersected with a changed-path set. Every authoritative
      // Production root must fail closed before diff-based pruning, including when only an
      // external JSON/SQL provider changed.
      for (const root of PRODUCTION_STARTUP_SCHEMA_ROOTS) {
        if (!snapshot.repositoryPaths.has(root)) continue;
        if (hasUnprovenRuntimeModuleLoad(snapshot.read(root), root, snapshot.repositoryPaths))
          throw new Error(`Migration dependency ${root} uses dynamic import or require`);
      }
      const roots = authorityRootsIntersectingDiff(snapshot, candidatePaths);
      for (const path of candidatePaths) {
        try {
          const content = snapshot.read(path);
          if (isProductionStartupSchemaRootSource(path, content)) roots.add(path);
        } catch {
          // Removed paths remain represented by the opposite side's root set.
        }
      }
      return roots;
    };
    const baselineSnapshot = snapshotFor(baseline);
    const targetSnapshot = snapshotFor(target);
    baselineClosure = buildMigrationDependencyClosure(
      execFileSync,
      cwd,
      baseline,
      baselineSnapshot,
      startupSchemaRoots(baseline),
    );
    targetClosure = buildMigrationDependencyClosure(
      execFileSync,
      cwd,
      target,
      targetSnapshot,
      startupSchemaRoots(target),
    );
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    blockingReasons.push(
      `Migration execution dependency closure could not be proven from the production baseline.${detail}`,
    );
  }

  const newlyReachable = new Set([...targetClosure].filter((path) => !baselineClosure.has(path)));
  const noLongerReachable = [...baselineClosure].filter((path) => !targetClosure.has(path));
  let reviews = { entries: new Map(), digest: null };
  try {
    reviews = loadMigrationReviews({
      baseline,
      baselineSnapshot: snapshotFor(baseline),
      targetSnapshot: snapshotFor(target),
    });
  } catch (error) {
    blockingReasons.push(`Migration review validation failed: ${error.message}`);
  }
  candidatePaths.push(...newlyReachable);
  for (const path of noLongerReachable) {
    if (reviews.entries.get(path)?.classification === 'no-schema-change') {
      candidatePaths.push(path);
      continue;
    }
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
  // 自动判定为「无结构变更」的依赖模块：既不进 blockingReasons，也不把计划抬成 expand。
  const sqlNeutralPaths = new Set();
  const readBaselineContent = (path) => {
    try {
      const snapshot = snapshotFor(baseline);
      return snapshot.repositoryPaths.has(path) ? snapshot.read(path) : null;
    } catch {
      return undefined;
    }
  };
  for (const path of paths) {
    const reviewed = reviews.entries.get(path);
    if (reviewed) {
      if (reviewed.classification === 'contract') {
        blockingReasons.push(
          `Migration ${path} has a reviewed contract change and requires a separate contract release.`,
        );
      }
      inventory.push({
        path,
        baselineBlobDigest: reviewed.baselineDigest,
        targetBlobDigest: reviewed.targetDigest,
        classification: reviewed.classification,
        reviewDigest: reviews.digest,
      });
      continue;
    }
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
    if (
      isSqlNeutralDependencyChange({
        path,
        content,
        baselineContent: newlyReachable.has(path) ? null : readBaselineContent(path),
        diff,
        additions,
        deletions,
      })
    ) {
      sqlNeutralPaths.add(path);
      inventory.push({
        path,
        targetBlobDigest: digest(content),
        addedLinesDigest: digest(additions),
        deletedLinesDigest: digest(deletions),
        classification: 'no-schema-change',
      });
      continue;
    }
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

  const phase = paths.some(
    (path) =>
      !sqlNeutralPaths.has(path) &&
      reviews.entries.get(path)?.classification !== 'no-schema-change',
  )
    ? 'expand'
    : 'none';
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

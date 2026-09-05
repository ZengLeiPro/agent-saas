// Admin Runner 受控命令清单（唯一真相源）。
//
// 每条命令除入口/源文件外还必须声明治理 metadata：风险等级、默认模式、写意图 flag、
// 升级 flag、是否接受 --authorization-ref、重入语义、配置需求、受支持环境。
// build-admin-runner 把这些原样写进 dist/admin/manifest.json；build-release 与测试
// 校验 manifest、文档与本清单三者一致，任何漂移 fail closed。
//
// 新增命令：① 脚本必须默认 dry-run / 只读且写操作有显式 flag；② 在此登记完整
// metadata；③ 运行 admin-runner.test.mjs 让文档段落随之更新（测试比对生成结果）。

export const ADMIN_RUNNER_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const ADMIN_RUNNER_DEFAULT_MODES = Object.freeze(['read_only', 'dry_run']);
export const ADMIN_RUNNER_IDEMPOTENCY = Object.freeze(['idempotent', 'resumable', 'one_shot']);
export const ADMIN_RUNNER_ENVIRONMENTS = Object.freeze([
  'production',
  'staging',
  'development',
  'test',
]);
export const ADMIN_RUNNER_CONFIG_REQUIREMENTS = Object.freeze([
  'app_config',
  'pg_connection',
  'transcripts_root',
  'release_layout',
]);

const ALL_ENVIRONMENTS = [...ADMIN_RUNNER_ENVIRONMENTS];
const FLAG_PATTERN = /^--[a-z][a-z0-9-]*$/u;
const COMMAND_PATTERN = /^[a-z0-9-]+$/u;

export const ADMIN_RUNNER_ENTRIES = Object.freeze([
  {
    command: 'migrate-events-file-to-pg',
    source: 'scripts/migrate-events-file-to-pg.mts',
    description:
      'file EventStore jsonl -> PG runtime_events 一次性 ETL；默认 dry-run，--execute 写入',
    governance: {
      riskLevel: 'high',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--execute',
          riskLevel: 'high',
          description: '把 jsonl 历史事件写入 PG runtime_events 并推进 cursor',
        },
      ],
      escalationFlags: [
        {
          flag: '--force',
          requiresWriteIntent: '--execute',
          riskLevel: 'critical',
          description: '允许向已有事件的 session 追加，sequence 撞 UNIQUE 时整 session 回滚',
        },
      ],
      acceptsAuthorizationRef: false,
      idempotency: 'resumable',
      configRequirements: ['pg_connection', 'transcripts_root'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
  {
    command: 'migrate-platform-tenant-pantheon',
    source: 'scripts/migrate-platform-tenant-pantheon.mts',
    description: '平台租户目录迁移到 pantheon 布局；默认 dry-run，--apply 写入',
    governance: {
      riskLevel: 'high',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--apply',
          riskLevel: 'high',
          description: '改写 tenants/users 数据文件为 pantheon 布局',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: false,
      idempotency: 'one_shot',
      configRequirements: ['release_layout'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
  {
    command: 'backfill-runtime-sessions',
    source: 'scripts/backfill-runtime-sessions.mts',
    description: 'runtime session 背填到 PG；默认 dry-run，--execute 写入',
    governance: {
      riskLevel: 'medium',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--execute',
          riskLevel: 'medium',
          description: '从 transcript .meta.json 回填 runtime_sessions',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: false,
      idempotency: 'resumable',
      configRequirements: ['app_config', 'pg_connection', 'transcripts_root'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
  {
    command: 'repair-runtime-session-statuses',
    source: 'scripts/repair-runtime-session-statuses.mts',
    description: '按 runtime_runs 真源修复会话目录假 active；默认 dry-run，--execute 幂等写入',
    governance: {
      riskLevel: 'medium',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--execute',
          riskLevel: 'medium',
          description: '更新 transcript .meta.json 与 runtime_sessions 的过期 runtimeStatus',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: false,
      idempotency: 'idempotent',
      configRequirements: ['app_config', 'pg_connection', 'transcripts_root'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
  {
    command: 'repair-taskboard-workflow',
    source: 'scripts/repairTaskboardWorkflow.ts',
    description: 'taskboard workflow 状态修复；默认 dry-run，--apply 写入',
    governance: {
      riskLevel: 'high',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--apply',
          riskLevel: 'high',
          description: '按 findings 修正 taskboard 任务/执行/授权记录',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: false,
      idempotency: 'idempotent',
      configRequirements: ['pg_connection'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      // 脚本默认把审计 JSON/MD 写到相对 cwd；launcher 的 cwd 是密封 release 目录，必须显式指定输出位置。
      requiredFlags: ['--output'],
    },
  },
  {
    command: 'runtime-events-maintenance',
    source: 'src/scripts/runtime-events-maintenance.mts',
    description:
      'runtime events retention 维护；默认严格只读 dry-run，写操作需 --authorization-ref',
    governance: {
      riskLevel: 'critical',
      defaultMode: 'read_only',
      writeIntents: [
        {
          flag: '--execute-retention',
          riskLevel: 'critical',
          description:
            '按 retention 策略物理删除 runtime_events；脚本另要求 --legal-delete-through',
        },
        {
          flag: '--execute-drop',
          riskLevel: 'high',
          description: '删除冗余索引；脚本另要求 --index-observed-from 且观测窗口 >= 7 天',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: true,
      idempotency: 'idempotent',
      configRequirements: ['app_config', 'pg_connection'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
  {
    command: 'context-derived-replay',
    source: 'scripts/context-derived-replay.mts',
    description: 'derived context 投影重放修复；默认 dry-run，--apply 写入',
    governance: {
      riskLevel: 'medium',
      defaultMode: 'dry_run',
      writeIntents: [
        {
          flag: '--apply',
          riskLevel: 'medium',
          description: '重放 derived 投影；脚本另要求 --confirm-tenant 与 --expected-cursor',
        },
      ],
      escalationFlags: [],
      acceptsAuthorizationRef: false,
      idempotency: 'idempotent',
      configRequirements: ['app_config', 'pg_connection'],
      supportedEnvironments: ALL_ENVIRONMENTS,
      requiredFlags: [],
    },
  },
]);

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
}

function assertUniqueList(values, allowed, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not repeat`);
  for (const value of values) assertEnum(value, allowed, label);
}

function assertFlag(flag, label) {
  if (typeof flag !== 'string' || !FLAG_PATTERN.test(flag)) {
    throw new Error(`${label} must be a --kebab-case flag, got ${JSON.stringify(flag)}`);
  }
}

// 与运行时 manifest.ts 的严格解析同一键集：出包放行、运行拒绝会让整批命令在生产不可用。
function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} keys drifted: expected [${expected.join(', ')}] got [${actual.join(', ')}]`,
    );
  }
}

export function validateAdminRunnerGovernance(command, governance) {
  const label = `Admin Runner command ${command}`;
  if (!governance || typeof governance !== 'object') throw new Error(`${label} lacks governance`);
  const expectedKeys = [
    'riskLevel',
    'defaultMode',
    'writeIntents',
    'escalationFlags',
    'acceptsAuthorizationRef',
    'idempotency',
    'configRequirements',
    'supportedEnvironments',
    'requiredFlags',
  ];
  const actualKeys = Object.keys(governance).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(
      `${label} governance keys drifted: expected [${expectedKeys.join(', ')}] got [${actualKeys.join(', ')}]`,
    );
  }
  assertEnum(governance.riskLevel, ADMIN_RUNNER_RISK_LEVELS, `${label} riskLevel`);
  assertEnum(governance.defaultMode, ADMIN_RUNNER_DEFAULT_MODES, `${label} defaultMode`);
  assertEnum(governance.idempotency, ADMIN_RUNNER_IDEMPOTENCY, `${label} idempotency`);
  if (typeof governance.acceptsAuthorizationRef !== 'boolean') {
    throw new Error(`${label} acceptsAuthorizationRef must be boolean`);
  }
  assertUniqueList(
    governance.configRequirements,
    ADMIN_RUNNER_CONFIG_REQUIREMENTS,
    `${label} configRequirements`,
  );
  assertUniqueList(
    governance.supportedEnvironments,
    ADMIN_RUNNER_ENVIRONMENTS,
    `${label} supportedEnvironments`,
  );
  if (governance.supportedEnvironments.length === 0) {
    throw new Error(`${label} must support at least one environment`);
  }
  if (!Array.isArray(governance.writeIntents))
    throw new Error(`${label} writeIntents must be array`);
  const writeFlags = new Set();
  for (const intent of governance.writeIntents) {
    assertFlag(intent?.flag, `${label} writeIntent flag`);
    assertExactKeys(
      intent,
      ['flag', 'riskLevel', 'description'],
      `${label} writeIntent ${intent.flag}`,
    );
    if (writeFlags.has(intent.flag)) throw new Error(`${label} repeats write flag ${intent.flag}`);
    writeFlags.add(intent.flag);
    assertEnum(intent.riskLevel, ADMIN_RUNNER_RISK_LEVELS, `${label} writeIntent riskLevel`);
    if (typeof intent.description !== 'string' || !intent.description.trim()) {
      throw new Error(`${label} writeIntent ${intent.flag} lacks description`);
    }
  }
  if (!Array.isArray(governance.escalationFlags)) {
    throw new Error(`${label} escalationFlags must be array`);
  }
  for (const escalation of governance.escalationFlags) {
    assertFlag(escalation?.flag, `${label} escalation flag`);
    assertExactKeys(
      escalation,
      ['flag', 'requiresWriteIntent', 'riskLevel', 'description'],
      `${label} escalation ${escalation.flag}`,
    );
    if (writeFlags.has(escalation.flag)) {
      throw new Error(`${label} escalation flag ${escalation.flag} collides with a write intent`);
    }
    if (!writeFlags.has(escalation.requiresWriteIntent)) {
      throw new Error(
        `${label} escalation flag ${escalation.flag} must require a declared write intent`,
      );
    }
    assertEnum(escalation.riskLevel, ADMIN_RUNNER_RISK_LEVELS, `${label} escalation riskLevel`);
    if (typeof escalation.description !== 'string' || !escalation.description.trim()) {
      throw new Error(`${label} escalation ${escalation.flag} lacks description`);
    }
  }
  if (!Array.isArray(governance.requiredFlags)) {
    throw new Error(`${label} requiredFlags must be array`);
  }
  if (new Set(governance.requiredFlags).size !== governance.requiredFlags.length) {
    throw new Error(`${label} requiredFlags must not repeat`);
  }
  for (const flag of governance.requiredFlags) {
    assertFlag(flag, `${label} required flag`);
    if (writeFlags.has(flag)) {
      throw new Error(`${label} required flag ${flag} must not be a write intent`);
    }
  }
  if (governance.defaultMode === 'read_only' && governance.writeIntents.length === 0) {
    // 纯只读命令合法；dry_run 语义则必然存在可写 flag。
    return governance;
  }
  if (governance.defaultMode === 'dry_run' && governance.writeIntents.length === 0) {
    throw new Error(`${label} declares dry_run but no write intent`);
  }
  return governance;
}

export function validateAdminRunnerEntries(entries = ADMIN_RUNNER_ENTRIES) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Admin Runner entries must declare at least one command');
  }
  const commands = new Set();
  for (const entry of entries) {
    if (typeof entry.command !== 'string' || !COMMAND_PATTERN.test(entry.command)) {
      throw new Error(`Admin Runner command name invalid: ${JSON.stringify(entry.command)}`);
    }
    if (commands.has(entry.command))
      throw new Error(`Admin Runner command repeated: ${entry.command}`);
    commands.add(entry.command);
    if (typeof entry.source !== 'string' || !entry.source.trim()) {
      throw new Error(`Admin Runner command ${entry.command} lacks source`);
    }
    if (typeof entry.description !== 'string' || !entry.description.trim()) {
      throw new Error(`Admin Runner command ${entry.command} lacks description`);
    }
    validateAdminRunnerGovernance(entry.command, entry.governance);
  }
  return entries;
}

/** docs/admin-runner.md 第 2 节命令表由此生成；测试比对，漂移即失败。 */
export function renderAdminRunnerCommandTable(entries = ADMIN_RUNNER_ENTRIES) {
  const header = [
    '| command | 风险 | 默认模式 | 写意图 flag | 升级 flag | 必填 flag | 授权单号 | 重入语义 | 配置需求（声明） | 环境 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = entries.map((entry) => {
    const g = entry.governance;
    const writes = g.writeIntents.map((intent) => `\`${intent.flag}\`(${intent.riskLevel})`);
    const escalations = g.escalationFlags.map(
      (flag) => `\`${flag.flag}\`(${flag.riskLevel}, 需 \`${flag.requiresWriteIntent}\`)`,
    );
    const required = g.requiredFlags.map((flag) => `\`${flag}\``);
    return `| \`${entry.command}\` | ${g.riskLevel} | ${g.defaultMode} | ${writes.join('<br>') || '—'} | ${
      escalations.join('<br>') || '—'
    } | ${required.join('<br>') || '—'} | ${g.acceptsAuthorizationRef ? '脚本原生接受' : 'launcher 持有'} | ${g.idempotency} | ${g.configRequirements.join(', ')} | ${g.supportedEnvironments.join(', ')} |`;
  });
  return [...header, ...rows].join('\n');
}

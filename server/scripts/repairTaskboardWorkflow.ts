import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import { sanitizeIdentifier } from '../src/taskboard/storeHelpers.js';

const { Pool } = pg;

export type WorkflowRepairFinding = {
  type: string;
  taskId?: string;
  boardId?: string;
  detail: Record<string, unknown>;
};

type Args = {
  apply: boolean;
  taskId?: string;
  boardId?: string;
  tablePrefix: string;
  output: string;
};

export function parseWorkflowRepairArgs(argv: string[]): Args {
  const value = (name: string) => argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('Choose either --dry-run or --apply');
  const tablePrefix = sanitizeIdentifier(value('--table-prefix') ?? process.env.TASKBOARD_TABLE_PREFIX ?? 'runtime');
  return {
    apply,
    ...(value('--task-id') ? { taskId: value('--task-id') } : {}),
    ...(value('--board-id') ? { boardId: value('--board-id') } : {}),
    tablePrefix,
    output: value('--output') ?? `taskboard-workflow-repair-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
  };
}

const ACTIVE_EXECUTION = "e.status IN ('queued','running','waiting_user','waiting_approval') AND e.resolved_at IS NULL AND e.superseded_at IS NULL";
const SOURCE_MERGE_FACT = "s.state='merged' OR s.merged_commit_oid IS NOT NULL OR s.provider_receipt_id IS NOT NULL";

function scope(boardExpression: string, taskExpressions: string[]): string {
  return ` AND ($1::text IS NULL OR $1 IN (${taskExpressions.join(',')})) AND ($2::text IS NULL OR ${boardExpression}=$2)`;
}

function canonicalHash(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return entry;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: pnpm -F server repair:taskboard-workflow -- [--dry-run|--apply] [--task-id=ID] [--board-id=ID] [--table-prefix=PREFIX] [--output=PATH]');
    return;
  }
  const args = parseWorkflowRepairArgs(argv);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const p = args.tablePrefix;
  const tables = {
    tasks: `${p}_taskboard_tasks`, boards: `${p}_taskboards`, execs: `${p}_taskboard_execs`,
    sources: `${p}_taskboard_integration_sources`, attempts: `${p}_taskboard_remediation_attempts`,
    changes: `${p}_taskboard_changes`, blocks: `${p}_taskboard_block_episodes`,
    operations: `${p}_taskboard_merge_ops`, continuations: `${p}_taskboard_cont_outbox`,
    cancellations: `${p}_taskboard_cancel_outbox`, lanes: `${p}_taskboard_integration_lanes`,
    authorizations: `${p}_taskboard_merge_auths`, resolutions: `${p}_taskboard_resolutions`,
  };
  const params: unknown[] = [args.taskId ?? null, args.boardId ?? null];
  const deliveryScope = scope('t.board_id', [
    't.id', 's.integration_task_id',
    `(CASE WHEN EXISTS (SELECT 1 FROM ${tables.attempts} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=$1) THEN $1 END)`,
  ]);
  const deliveryIncidentScope = scope('t.board_id', [
    't.id',
    `(SELECT s.integration_task_id FROM ${tables.sources} s WHERE s.delivery_task_id=t.id ORDER BY s.updated_at DESC LIMIT 1)`,
    `(CASE WHEN EXISTS (SELECT 1 FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id WHERE s.delivery_task_id=t.id AND a.remediation_task_id=$1) THEN $1 END)`,
  ]);
  const findings: WorkflowRepairFinding[] = [];
  const client = await pool.connect();
  try {
    const merged = await client.query(
      `SELECT t.id,t.board_id,t.status,t.merged_commit_oid,s.id AS source_id,
              s.integration_task_id,s.merged_commit_oid AS source_oid,s.provider_receipt_id
         FROM ${tables.tasks} t JOIN ${tables.sources} s ON s.delivery_task_id=t.id
        WHERE (${SOURCE_MERGE_FACT})
          AND (t.status<>'done' OR (s.merged_commit_oid IS NOT NULL AND t.merged_commit_oid IS DISTINCT FROM s.merged_commit_oid))${deliveryScope}`,
      params,
    );
    for (const row of merged.rows) findings.push({ type: 'merged_projection_mismatch', taskId: row.id, boardId: row.board_id, detail: row });

    const active = await client.query(
      `SELECT DISTINCT t.id,t.board_id,e.id AS execution_id,e.run_id
         FROM ${tables.tasks} t JOIN ${tables.execs} e ON e.task_id=t.id
        WHERE ${ACTIVE_EXECUTION}
          AND (t.merged_commit_oid IS NOT NULL OR EXISTS (
            SELECT 1 FROM ${tables.sources} s WHERE s.delivery_task_id=t.id AND (${SOURCE_MERGE_FACT})
          ))${deliveryIncidentScope}`,
      params,
    );
    for (const row of active.rows) findings.push({ type: 'merged_active_execution', taskId: row.id, boardId: row.board_id, detail: row });

    const activeContinuations = await client.query(
      `SELECT DISTINCT t.id,t.board_id,o.run_id
         FROM ${tables.tasks} t JOIN ${tables.continuations} o ON o.task_id=t.id
        WHERE o.status IN ('pending','dispatching','dispatched')
          AND (t.merged_commit_oid IS NOT NULL OR EXISTS (
            SELECT 1 FROM ${tables.sources} s WHERE s.delivery_task_id=t.id AND (${SOURCE_MERGE_FACT})
          ))${deliveryIncidentScope}`,
      params,
    );
    for (const row of activeContinuations.rows) findings.push({
      type: 'merged_active_continuation', taskId: row.id, boardId: row.board_id, detail: row,
    });

    const duplicateResolutions = await client.query(
      `SELECT t.id,t.board_id,c.payload->>'runId' AS run_id,count(*)::int AS resolution_count
         FROM ${tables.tasks} t JOIN ${tables.changes} c ON c.task_id=t.id
        WHERE c.change_type IN ('execution.resolved','execution.resolved.v2')${deliveryIncidentScope}
        GROUP BY t.id,t.board_id,c.payload->>'runId' HAVING count(*)>1`,
      params,
    );
    for (const row of duplicateResolutions.rows) findings.push({
      type: 'duplicate_legacy_resolution', taskId: row.id, boardId: row.board_id, detail: row,
    });

    const mismatchedPurpose = await client.query(
      `SELECT t.id,t.board_id,e.id AS execution_id,e.purpose,e.status
         FROM ${tables.tasks} t JOIN ${tables.execs} e ON e.task_id=t.id
        WHERE t.kind='integration' AND e.purpose<>'merge' AND ${ACTIVE_EXECUTION}${scope('t.board_id', ['t.id'])}`,
      params,
    );
    for (const row of mismatchedPurpose.rows) findings.push({ type: 'integration_purpose_mismatch', taskId: row.id, boardId: row.board_id, detail: row });

    const remediation = await client.query(
      `SELECT t.id,t.board_id,t.status FROM ${tables.tasks} t
        WHERE t.kind='remediation' AND t.status='ready_to_merge'
          AND EXISTS (
            SELECT 1 FROM ${tables.execs} e JOIN ${tables.resolutions} r ON r.execution_id=e.id
             WHERE e.task_id=t.id AND e.purpose='review' AND r.outcome='approved'
          )${scope('t.board_id', [
          't.id',
          `(SELECT s.delivery_task_id FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id LIMIT 1)`,
          `(SELECT s.integration_task_id FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id LIMIT 1)`,
        ])}`,
      params,
    );
    for (const row of remediation.rows) findings.push({ type: 'remediation_not_converged', taskId: row.id, boardId: row.board_id, detail: row });

    const remediationWithoutApproval = await client.query(
      `SELECT t.id,t.board_id,t.status FROM ${tables.tasks} t
        WHERE t.kind='remediation' AND t.status='ready_to_merge'
          AND NOT EXISTS (
            SELECT 1 FROM ${tables.execs} e JOIN ${tables.resolutions} r ON r.execution_id=e.id
             WHERE e.task_id=t.id AND e.purpose='review' AND r.outcome='approved'
          )${scope('t.board_id', [
          't.id',
          `(SELECT s.delivery_task_id FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id LIMIT 1)`,
          `(SELECT s.integration_task_id FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id WHERE a.remediation_task_id=t.id LIMIT 1)`,
        ])}`,
      params,
    );
    for (const row of remediationWithoutApproval.rows) findings.push({
      type: 'manual_remediation_review_required', taskId: row.id, boardId: row.board_id, detail: row,
    });

    const mergedRemediations = await client.query(
      `SELECT r.id,t.board_id,a.id AS attempt_id,a.state,s.id AS source_id,
              s.delivery_task_id,s.integration_task_id
         FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id
         JOIN ${tables.tasks} r ON r.id=a.remediation_task_id
         JOIN ${tables.tasks} t ON t.id=s.delivery_task_id
        WHERE (${SOURCE_MERGE_FACT}) AND (r.status NOT IN ('done','canceled') OR a.state='active')${scope('t.board_id', [
          'r.id', 's.delivery_task_id', 's.integration_task_id',
        ])}`,
      params,
    );
    for (const row of mergedRemediations.rows) findings.push({
      type: 'merged_remediation_not_converged', taskId: row.id, boardId: row.board_id, detail: row,
    });

    const integrations = await client.query(
      `SELECT i.id,i.board_id,l.repository_id
         FROM ${tables.tasks} i JOIN ${tables.sources} s ON s.integration_task_id=i.id
         LEFT JOIN ${tables.lanes} l ON l.active_integration_task_id=i.id
        WHERE i.kind='integration'
        GROUP BY i.id,i.board_id,l.repository_id
       HAVING bool_and(${SOURCE_MERGE_FACT}) AND (i.status<>'done' OR l.repository_id IS NOT NULL)
          AND ($1::text IS NULL OR bool_or($1 IN (
            i.id,s.delivery_task_id,
            (CASE WHEN EXISTS (SELECT 1 FROM ${tables.attempts} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=$1) THEN $1 END)
          )))
          AND ($2::text IS NULL OR i.board_id=$2)`,
      params,
    );
    for (const row of integrations.rows) findings.push({
      type: 'integration_not_converged', taskId: row.id, boardId: row.board_id, detail: row,
    });

    const duplicateSources = await client.query(
      `SELECT min(t.id) AS id,min(t.board_id) AS board_id,s.repository_id,s.provider_pull_request_id,
              count(*) FILTER (WHERE ${SOURCE_MERGE_FACT})::int AS merge_fact_count,
              jsonb_agg(jsonb_build_object(
                'sourceId',s.id,'deliveryTaskId',s.delivery_task_id,'integrationTaskId',s.integration_task_id,
                'hasMergeFact',(${SOURCE_MERGE_FACT})
              ) ORDER BY CASE WHEN (${SOURCE_MERGE_FACT}) THEN 0 ELSE 1 END,s.created_at,s.id) AS sources
         FROM ${tables.sources} s JOIN ${tables.tasks} t ON t.id=s.delivery_task_id
        WHERE s.state NOT IN ('merged','canceled')
        GROUP BY s.repository_id,s.provider_pull_request_id
       HAVING count(*)>1
          AND ($1::text IS NULL OR bool_or($1 IN (
            t.id,s.integration_task_id,
            (CASE WHEN EXISTS (SELECT 1 FROM ${tables.attempts} a WHERE a.integration_source_id=s.id AND a.remediation_task_id=$1) THEN $1 END)
          )))
          AND ($2::text IS NULL OR bool_or(t.board_id=$2))`,
      params,
    );
    for (const row of duplicateSources.rows) findings.push({ type: 'duplicate_active_source', taskId: row.id, boardId: row.board_id, detail: row });

    const advisoryCandidates = await client.query(
      `SELECT t.id,t.board_id,t.title FROM ${tables.tasks} t
        WHERE t.kind='delivery' AND t.provider_pull_request_id IS NULL AND t.merged_commit_oid IS NULL
          AND (t.title||' '||t.description) ~ '(仅回答|不实施|无需修改)'
          AND NOT EXISTS (SELECT 1 FROM ${tables.sources} s WHERE s.delivery_task_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM ${tables.execs} e WHERE e.task_id=t.id AND e.status IN ('queued','running','waiting_user','waiting_approval'))${scope('t.board_id', ['t.id'])}`,
      params,
    );
    for (const row of advisoryCandidates.rows) findings.push({ type: 'manual_advisory_reclassification_candidate', taskId: row.id, boardId: row.board_id, detail: row });

    let applied = 0;
    if (args.apply) {
      await client.query('BEGIN');
      const repairLog = `${p}_taskboard_workflow_repairs`;
      await client.query(`CREATE TABLE IF NOT EXISTS ${repairLog} (command_id TEXT PRIMARY KEY, finding_type TEXT NOT NULL, task_id TEXT, detail JSONB NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      for (const finding of findings) {
        if (finding.type === 'manual_advisory_reclassification_candidate'
          || finding.type === 'manual_remediation_review_required'
          || finding.type === 'duplicate_legacy_resolution') continue;
        if (finding.type === 'duplicate_active_source' && Number(finding.detail.merge_fact_count ?? 0) > 1) {
          throw new Error(`TASKBOARD_DUPLICATE_ACTIVE_SOURCE_AMBIGUOUS: ${String(finding.detail.repository_id)}:${String(finding.detail.provider_pull_request_id)}`);
        }
        const commandId = canonicalHash({ v: 2, finding });
        const claimed = await client.query(
          `INSERT INTO ${repairLog}(command_id,finding_type,task_id,detail) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING command_id`,
          [commandId, finding.type, finding.taskId ?? null, JSON.stringify(finding.detail)],
        );
        if (!claimed.rows[0]) continue;
        if (finding.type === 'merged_projection_mismatch') {
          await client.query(
            `UPDATE ${tables.tasks}
                SET status='done',merged_commit_oid=COALESCE($2::text,merged_commit_oid),
                    completed_at=COALESCE(completed_at,now()),workflow_epoch=workflow_epoch+1,
                    next_action='none',next_action_revision=next_action_revision+1,version=version+1,updated_at=now()
              WHERE id=$1 AND (status<>'done' OR ($2::text IS NOT NULL AND merged_commit_oid IS DISTINCT FROM $2::text))`,
            [finding.taskId, finding.detail.source_oid],
          );
          await client.query(
            `UPDATE ${tables.sources}
                SET state='merged',last_error=NULL,updated_at=now()
              WHERE id=$1 AND (state='merged' OR merged_commit_oid IS NOT NULL OR provider_receipt_id IS NOT NULL)`,
            [finding.detail.source_id],
          );
          await client.query(
            `UPDATE ${tables.blocks} SET closed_at=COALESCE(closed_at,now()) WHERE task_id=$1 AND closed_at IS NULL`,
            [finding.taskId],
          );
          await client.query(
            `UPDATE ${tables.tasks} r SET status=CASE WHEN a.state='resolved' THEN 'done' ELSE 'canceled' END,
                    completed_at=now(),workflow_epoch=workflow_epoch+1,next_action='none',
                    next_action_revision=next_action_revision+1,version=r.version+1,updated_at=now()
               FROM ${tables.attempts} a JOIN ${tables.sources} s ON s.id=a.integration_source_id
              WHERE s.delivery_task_id=$1 AND r.id=a.remediation_task_id AND r.status NOT IN ('done','canceled')`,
            [finding.taskId],
          );
        } else if (finding.type === 'merged_active_execution' || finding.type === 'integration_purpose_mismatch') {
          const fenced = await client.query(
            `UPDATE ${tables.execs}
                SET status='cancelled',finished_at=COALESCE(finished_at,now()),
                    superseded_at=COALESCE(superseded_at,now()),fence_epoch=fence_epoch+1,
                    terminal_reason_code='historical_repair',updated_at=now()
              WHERE id=$1 AND superseded_at IS NULL RETURNING id,run_id,task_id,fence_epoch`,
            [finding.detail.execution_id],
          );
          if (fenced.rows[0]) {
            await client.query(
              `INSERT INTO ${tables.cancellations}(id,execution_id,run_id,task_id,reason,fence_epoch)
               VALUES($1,$2,$3,$4,'historical_repair',$5) ON CONFLICT (execution_id) DO NOTHING`,
              [canonicalHash(`cancel:${String(fenced.rows[0].id)}`),fenced.rows[0].id,
                fenced.rows[0].run_id,fenced.rows[0].task_id,fenced.rows[0].fence_epoch],
            );
          }
        } else if (finding.type === 'merged_active_continuation') {
          await client.query(
            `UPDATE ${tables.continuations}
                SET status='completed',lease_id=NULL,lease_expires_at=NULL,
                    reconcile_lease_id=NULL,reconcile_lease_expires_at=NULL,updated_at=now()
              WHERE run_id=$1 AND status<>'completed'`,
            [finding.detail.run_id],
          );
        } else if (finding.type === 'remediation_not_converged') {
          await client.query(
            `UPDATE ${tables.tasks} SET status='done',completed_at=COALESCE(completed_at,now()),
                    workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
                    version=version+1,updated_at=now() WHERE id=$1 AND status='ready_to_merge'`,
            [finding.taskId],
          );
          await client.query(`UPDATE ${tables.attempts} SET state='resolved',resolved_at=COALESCE(resolved_at,now()) WHERE remediation_task_id=$1`, [finding.taskId]);
        } else if (finding.type === 'merged_remediation_not_converged') {
          await client.query(
            `UPDATE ${tables.tasks} SET status=CASE WHEN $2='resolved' THEN 'done' ELSE 'canceled' END,
                    completed_at=now(),workflow_epoch=workflow_epoch+1,next_action='none',
                    next_action_revision=next_action_revision+1,version=version+1,updated_at=now()
              WHERE id=$1 AND status NOT IN ('done','canceled')`,
            [finding.taskId, finding.detail.state],
          );
          await client.query(
            `UPDATE ${tables.attempts}
                SET state=CASE WHEN state='resolved' THEN state ELSE 'superseded' END,
                    resolved_at=CASE WHEN state='resolved' THEN COALESCE(resolved_at,now()) ELSE resolved_at END,
                    superseded_at=CASE WHEN state<>'resolved' THEN COALESCE(superseded_at,now()) ELSE superseded_at END
              WHERE id=$1`,
            [finding.detail.attempt_id],
          );
        } else if (finding.type === 'integration_not_converged') {
          await client.query(
            `UPDATE ${tables.tasks} SET status='done',completed_at=COALESCE(completed_at,now()),
                    workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
                    version=version+1,updated_at=now() WHERE id=$1 AND status<>'done'`,
            [finding.taskId],
          );
          await client.query(`UPDATE ${tables.authorizations} SET revoked_at=COALESCE(revoked_at,now()) WHERE integration_task_id=$1 AND revoked_at IS NULL`, [finding.taskId]);
          await client.query(`UPDATE ${tables.lanes} SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now() WHERE active_integration_task_id=$1`, [finding.taskId]);
        } else if (finding.type === 'duplicate_active_source') {
          const sources = Array.isArray(finding.detail.sources) ? finding.detail.sources as Array<Record<string, unknown>> : [];
          const [canonical, ...duplicates] = sources;
          if (!canonical || duplicates.length === 0) throw new Error('Malformed duplicate source finding');
          for (const duplicate of duplicates) {
            await client.query(
              `UPDATE ${tables.sources} SET state='canceled',last_error=$2,updated_at=now()
                WHERE id=$1 AND state NOT IN ('merged','canceled')`,
              [duplicate.sourceId, `Historical duplicate; canonical source ${String(canonical.sourceId)}`],
            );
            await client.query(
              `INSERT INTO ${tables.changes}(task_id,change_type,actor_type,actor_id,payload)
               VALUES($1,'integration.source_duplicate_canceled','system',$2,$3::jsonb)`,
              [duplicate.deliveryTaskId, commandId, JSON.stringify({
                commandId, canonicalSourceId: canonical.sourceId, canceledSourceId: duplicate.sourceId,
              })],
            );
          }
        }
        if (finding.taskId) {
          await client.query(
            `INSERT INTO ${tables.changes}(task_id,change_type,actor_type,actor_id,payload) VALUES($1,'task.projection_repaired','system',$2,$3::jsonb)`,
            [finding.taskId, commandId, JSON.stringify({ commandId, findingType: finding.type })],
          );
        }
        applied += 1;
      }
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${tables.sources}_apr_uq
           ON ${tables.sources}(repository_id,provider_pull_request_id)
        WHERE state NOT IN ('merged','canceled')`,
      );
      await client.query('COMMIT');
    }

    const postChecks = [
      await client.query(
        `SELECT count(*)::int AS count FROM ${tables.tasks} t JOIN ${tables.sources} s ON s.delivery_task_id=t.id
          WHERE (${SOURCE_MERGE_FACT})
            AND (t.status<>'done' OR (s.merged_commit_oid IS NOT NULL AND t.merged_commit_oid IS DISTINCT FROM s.merged_commit_oid))${deliveryScope}`,
        params,
      ),
      await client.query(
        `SELECT count(*)::int AS count FROM ${tables.tasks} t JOIN ${tables.execs} e ON e.task_id=t.id
          WHERE ${ACTIVE_EXECUTION}
            AND (t.merged_commit_oid IS NOT NULL OR EXISTS (SELECT 1 FROM ${tables.sources} s WHERE s.delivery_task_id=t.id AND (${SOURCE_MERGE_FACT})))${deliveryIncidentScope}`,
        params,
      ),
      await client.query(
        `SELECT count(*)::int AS count FROM ${tables.tasks} t JOIN ${tables.execs} e ON e.task_id=t.id
          WHERE t.kind='integration' AND e.purpose<>'merge' AND ${ACTIVE_EXECUTION}${scope('t.board_id', ['t.id'])}`,
        params,
      ),
      await client.query(
        `SELECT count(*)::int AS count FROM ${tables.tasks} t WHERE t.kind='remediation' AND t.status='ready_to_merge'${scope('t.board_id', ['t.id'])}`,
        params,
      ),
      await client.query(
        `SELECT count(*)::int AS count FROM (
           SELECT repository_id,provider_pull_request_id FROM ${tables.sources}
            WHERE state NOT IN ('merged','canceled')
            GROUP BY repository_id,provider_pull_request_id HAVING count(*)>1
         ) duplicates`,
      ),
      await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${tables.sources}_apr_uq`]),
    ];
    const after = {
      mergedProjectionMismatch: Number(postChecks[0].rows[0]?.count ?? 0),
      mergedActiveExecution: Number(postChecks[1].rows[0]?.count ?? 0),
      integrationPurposeMismatch: Number(postChecks[2].rows[0]?.count ?? 0),
      remediationReadyToMerge: Number(postChecks[3].rows[0]?.count ?? 0),
      duplicateActiveSource: Number(postChecks[4].rows[0]?.count ?? 0),
      activePrUniqueIndexPresent: postChecks[5].rows[0]?.present === true,
    };
    const summary = {
      mode: args.apply ? 'apply' : 'dry-run', taskId: args.taskId, boardId: args.boardId,
      scannedAt: new Date().toISOString(), findings: findings.length, applied,
      before: Object.fromEntries([...new Set(findings.map((finding) => finding.type))]
        .map((type) => [type, findings.filter((finding) => finding.type === type).length])),
      after,
      items: findings,
    };
    const jsonPath = resolve(`${args.output}.json`);
    const mdPath = resolve(`${args.output}.md`);
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(mdPath, `# Taskboard workflow repair audit\n\n- Mode: ${summary.mode}\n- Findings: ${summary.findings}\n- Applied: ${summary.applied}\n\n## Before\n\n\`\`\`json\n${JSON.stringify(summary.before, null, 2)}\n\`\`\`\n\n## After\n\n\`\`\`json\n${JSON.stringify(summary.after, null, 2)}\n\`\`\`\n`);
    console.log(JSON.stringify({ jsonPath, mdPath, findings: findings.length, applied, after }, null, 2));
  } catch (error) {
    if (args.apply) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

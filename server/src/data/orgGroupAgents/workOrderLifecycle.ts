import type pg from 'pg';

import type {
  OrgAgentControlInboxReceipt,
  OrgAgentWorkOrder,
  OrgAgentWorkOrderControl,
} from './types.js';
import { mapWorkOrder } from './storeMappers.js';

export async function getWorkOrder(
  pool: pg.Pool, table: string, tenantId: string, workOrderId: string,
): Promise<OrgAgentWorkOrder | null> {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND work_order_id=$2`,
    [tenantId, workOrderId],
  );
  return result.rows[0] ? mapWorkOrder(result.rows[0] as Record<string, unknown>) : null;
}

export async function getWorkOrderByShortId(
  pool: pg.Pool,
  table: string,
  tenantId: string,
  agentId: string,
  shortId: string,
): Promise<OrgAgentWorkOrder | null> {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND agent_id=$2 AND UPPER(short_id)=UPPER($3)`,
    [tenantId, agentId, shortId],
  );
  return result.rows[0] ? mapWorkOrder(result.rows[0] as Record<string, unknown>) : null;
}

export async function updateWorkOrderControl(
  pool: pg.Pool,
  table: string,
  input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control: OrgAgentWorkOrderControl;
  },
): Promise<OrgAgentWorkOrder> {
  const result = await pool.query(
    `UPDATE ${table} SET control_json=$4::jsonb,version=version+1,updated_at=NOW()
    WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3 RETURNING *`,
    [input.tenantId, input.workOrderId, input.expectedVersion, JSON.stringify(input.control)],
  );
  if (!result.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_VERSION_CONFLICT');
  return mapWorkOrder(result.rows[0] as Record<string, unknown>);
}

export async function pauseWorkOrder(
  pool: pg.Pool,
  workOrdersTable: string,
  attemptsTable: string,
  inboxTable: string,
  input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control?: OrgAgentWorkOrderControl;
    pauseContext?: {
      resultEnvelope: import('./types.js').OrgAgentResultEnvelope;
      checkpoint: Record<string, unknown>;
    };
    controlLease?: OrgAgentControlInboxReceipt;
  },
): Promise<OrgAgentWorkOrder> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const work = await client.query(
      `UPDATE ${workOrdersTable} SET state='paused',control_json=COALESCE($4::jsonb,control_json),
        version=version+1,completed_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3
        AND state IN ('queued','running','waiting_input') RETURNING *`,
      [input.tenantId, input.workOrderId, input.expectedVersion,
        input.control === undefined ? null : JSON.stringify(input.control)],
    );
    if (!work.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_CONFLICT');
    const attemptNo = Number((work.rows[0] as Record<string, unknown>).current_attempt_no);
    if (attemptNo > 0) {
      await client.query(
        `UPDATE ${attemptsTable} SET status='cancelled',publish_state='rejected',
          failure='superseded_by_work_order_pause',
          result_envelope_json=COALESCE($4::jsonb,result_envelope_json),
          checkpoint_json=COALESCE($5::jsonb,checkpoint_json),completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND work_order_id=$2 AND attempt_no=$3 AND status IN ('queued','running')`,
        [input.tenantId, input.workOrderId, attemptNo,
          input.pauseContext ? JSON.stringify(input.pauseContext.resultEnvelope) : null,
          input.pauseContext ? JSON.stringify(input.pauseContext.checkpoint) : null],
      );
    }
    if (input.controlLease)
      await persistControlInboxProgress(
        client, inboxTable, input.tenantId, input.workOrderId, input.controlLease,
      );
    await client.query('COMMIT');
    return mapWorkOrder(work.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queueWorkOrderAttempt(
  pool: pg.Pool,
  workOrdersTable: string,
  deliveriesTable: string,
  attemptsTable: string,
  inboxTable: string,
  input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control?: OrgAgentWorkOrderControl;
    supersedePendingCompletion?: boolean;
    supersedeActiveAttempt?: boolean;
    supersedeContext?: {
      resultEnvelope: import('./types.js').OrgAgentResultEnvelope;
      checkpoint: Record<string, unknown>;
    };
    controlLease?: OrgAgentControlInboxReceipt;
  },
): Promise<OrgAgentWorkOrder> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT * FROM ${workOrdersTable}
      WHERE tenant_id=$1 AND work_order_id=$2 FOR UPDATE`,
      [input.tenantId, input.workOrderId],
    );
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      Number(row.version) !== input.expectedVersion ||
      !(
        ['paused', 'waiting_input', 'completed', 'failed', 'cancelled'].includes(String(row.state))
        || (input.supersedeActiveAttempt === true
          && ['queued', 'running'].includes(String(row.state)))
      )
    ) {
      throw new Error('ORG_AGENT_WORK_ORDER_RESUME_CONFLICT');
    }
    const deliveryStates = await client.query(
      `SELECT delivery_state FROM ${deliveriesTable}
      WHERE tenant_id=$1 AND source_work_order_id=$2 AND delivery_kind='task_completion'
        AND delivery_state IN ('pending','sending','unknown') FOR UPDATE`,
      [input.tenantId, input.workOrderId],
    );
    const states = deliveryStates.rows.map((item) => String(item.delivery_state));
    if (states.includes('sending') || states.includes('unknown')) {
      throw new Error('ORG_AGENT_WORK_ORDER_COMPLETION_UNCERTAIN');
    }
    if (states.includes('pending') && input.supersedePendingCompletion !== true) {
      throw new Error('ORG_AGENT_WORK_ORDER_RESUME_CONFLICT');
    }
    if (states.includes('pending')) {
      await client.query(
        `UPDATE ${deliveriesTable} SET delivery_state='dead_letter',
          last_error='superseded_by_work_order_continuation',completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND source_work_order_id=$2 AND delivery_kind='task_completion'
          AND delivery_state='pending'`,
        [input.tenantId, input.workOrderId],
      );
    }
    if (input.supersedeActiveAttempt === true && ['queued', 'running'].includes(String(row.state))) {
      await client.query(
        `UPDATE ${attemptsTable} SET status='cancelled',publish_state='rejected',
          failure='superseded_by_work_order_control',
          result_envelope_json=COALESCE($4::jsonb,result_envelope_json),
          checkpoint_json=COALESCE($5::jsonb,checkpoint_json),completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND work_order_id=$2 AND attempt_no=$3
          AND status IN ('queued','running')`,
        [input.tenantId, input.workOrderId, Number(row.current_attempt_no),
          input.supersedeContext ? JSON.stringify(input.supersedeContext.resultEnvelope) : null,
          input.supersedeContext ? JSON.stringify(input.supersedeContext.checkpoint) : null],
      );
    }
    const updated = await client.query(
      `UPDATE ${workOrdersTable} SET state='queued',result_envelope_json=NULL,
        control_json=COALESCE($4::jsonb,control_json),version=version+1,
        completed_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3 RETURNING *`,
      [
        input.tenantId,
        input.workOrderId,
        input.expectedVersion,
        input.control === undefined ? null : JSON.stringify(input.control),
      ],
    );
    if (!updated.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_RESUME_CONFLICT');
    if (input.controlLease)
      await persistControlInboxProgress(
        client, inboxTable, input.tenantId, input.workOrderId, input.controlLease,
      );
    await client.query('COMMIT');
    return mapWorkOrder(updated.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeControlCommand(
  pool: pg.Pool,
  workOrdersTable: string,
  inboxTable: string,
  input: {
    tenantId: string;
    workOrderId: string;
    inboxReceipt: OrgAgentControlInboxReceipt;
  },
): Promise<OrgAgentWorkOrder> {
  return await settleControlCommand(pool, workOrdersTable, inboxTable, input, 'completed');
}

export async function failControlCommand(
  pool: pg.Pool,
  workOrdersTable: string,
  inboxTable: string,
  input: {
    tenantId: string;
    workOrderId: string;
    inboxReceipt: OrgAgentControlInboxReceipt;
    error: string;
  },
): Promise<OrgAgentWorkOrder> {
  return await settleControlCommand(pool, workOrdersTable, inboxTable, input, 'failed');
}

async function settleControlCommand(
  pool: pg.Pool,
  workOrdersTable: string,
  inboxTable: string,
  input: {
    tenantId: string;
    workOrderId: string;
    error?: string;
    inboxReceipt: OrgAgentControlInboxReceipt;
  },
  phase: 'completed' | 'failed',
): Promise<OrgAgentWorkOrder> {
  const inboxId = input.inboxReceipt.inboxId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE ${workOrdersTable}
      SET control_json=jsonb_set(
        CASE WHEN $5::text IS NULL THEN control_json
          ELSE jsonb_set(control_json,'{command,error}',to_jsonb($5::text),true) END,
        '{command,phase}',to_jsonb($4::text),false
      ),updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2
        AND control_json->'command'->>'inboxId'=$3
        AND control_json->'command'->>'phase'='prepared'
      RETURNING *`,
      [input.tenantId, input.workOrderId, inboxId, phase, input.error ?? null],
    );
    if (!updated.rows[0]) throw new Error('ORG_AGENT_CONTROL_COMMAND_STATE_CONFLICT');
    if (phase === 'completed')
      await persistControlInboxReceipt(client, inboxTable, input.tenantId, input.inboxReceipt);
    else
      await persistControlInboxProgress(
        client, inboxTable, input.tenantId, input.workOrderId, input.inboxReceipt, 'failed',
      );
    await client.query('COMMIT');
    return mapWorkOrder(updated.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function persistControlInboxReceipt(
  client: pg.PoolClient,
  inboxTable: string,
  tenantId: string,
  receipt: OrgAgentControlInboxReceipt,
): Promise<void> {
  const result = await client.query(
    `UPDATE ${inboxTable}
    SET state='reply_pending',response_text=$5,
      payload_json=payload_json || jsonb_build_object(
        'replyKind','normal','fastControlPhase','completed'
      ),
      last_error=NULL,updated_at=NOW()
    WHERE tenant_id=$1 AND inbox_id=$2 AND state='processing'
      AND lease_owner=$3 AND lease_fence=$4 AND lease_expires_at>NOW()
    RETURNING inbox_id`,
    [tenantId, receipt.inboxId, receipt.leaseOwner, receipt.leaseFence, receipt.responseText],
  );
  if (!result.rows[0]) throw new Error('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
}

async function persistControlInboxProgress(
  client: pg.PoolClient,
  inboxTable: string,
  tenantId: string,
  workOrderId: string,
  lease: OrgAgentControlInboxReceipt,
  phase: 'prepared' | 'failed' = 'prepared',
): Promise<void> {
  const result = await client.query(
    `UPDATE ${inboxTable}
    SET payload_json=payload_json || jsonb_build_object(
      'fastControlWorkOrderId',$5::text,'fastControlPhase',$6::text
    ),updated_at=NOW()
    WHERE tenant_id=$1 AND inbox_id=$2 AND state='processing'
      AND lease_owner=$3 AND lease_fence=$4 AND lease_expires_at>NOW()
    RETURNING inbox_id`,
    [tenantId, lease.inboxId, lease.leaseOwner, lease.leaseFence, workOrderId, phase],
  );
  if (!result.rows[0]) throw new Error('ORG_AGENT_FAST_CONTROL_LEASE_LOST');
}

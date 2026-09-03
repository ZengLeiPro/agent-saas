import type pg from 'pg';

import type { OrgAgentWorkOrder, OrgAgentWorkOrderControl } from './types.js';
import { mapWorkOrder } from './storeMappers.js';

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
  input: { tenantId: string; workOrderId: string; expectedVersion: number },
): Promise<OrgAgentWorkOrder> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const work = await client.query(
      `UPDATE ${workOrdersTable} SET state='paused',version=version+1,completed_at=NULL,updated_at=NOW()
      WHERE tenant_id=$1 AND work_order_id=$2 AND version=$3
        AND state IN ('queued','running','waiting_input') RETURNING *`,
      [input.tenantId, input.workOrderId, input.expectedVersion],
    );
    if (!work.rows[0]) throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_CONFLICT');
    const attemptNo = Number((work.rows[0] as Record<string, unknown>).current_attempt_no);
    if (attemptNo > 0) {
      await client.query(
        `UPDATE ${attemptsTable} SET status='cancelled',publish_state='rejected',
          failure='superseded_by_work_order_pause',completed_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND work_order_id=$2 AND attempt_no=$3 AND status IN ('queued','running')`,
        [input.tenantId, input.workOrderId, attemptNo],
      );
    }
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
  input: {
    tenantId: string;
    workOrderId: string;
    expectedVersion: number;
    control?: OrgAgentWorkOrderControl;
    supersedePendingCompletion?: boolean;
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
      !['paused', 'waiting_input', 'completed', 'failed', 'cancelled'].includes(String(row.state))
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
    await client.query('COMMIT');
    return mapWorkOrder(updated.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

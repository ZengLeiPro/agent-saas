import type { Pool } from 'pg';

export async function installBindingGenerationContract(pool: Pool, prefix: string): Promise<void> {
  const bindings = `${prefix}_org_agent_channel_bindings`;
  const deliveries = `${prefix}_agent_dws_delivery_intents`;
  const current = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid=$1::regclass AND confrelid=$2::regclass AND contype='f'
       AND pg_get_constraintdef(oid) LIKE
         'FOREIGN KEY (tenant_id, binding_id, agent_id, conversation_space_id, account_id, conversation_id)%'`,
    [deliveries, bindings],
  );
  const name = current.rows[0]?.conname;
  if (!name || current.rows.length !== 1)
    throw new Error('TEST_BINDING_GENERATION_CONTRACT_SOURCE_INVALID');
  const constraint = `"${name.replaceAll('"', '""')}"`;
  await pool.query(`ALTER TABLE ${deliveries} DROP CONSTRAINT ${constraint}`);
  await pool.query(`ALTER TABLE ${deliveries}
    ADD CONSTRAINT ${deliveries}_binding_generation_fk
    FOREIGN KEY (tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)
    REFERENCES ${bindings}(tenant_id,binding_id,agent_id,conversation_space_id,account_id,conversation_id)
    ON UPDATE CASCADE NOT VALID`);
  await pool.query(
    `ALTER TABLE ${deliveries} VALIDATE CONSTRAINT ${deliveries}_binding_generation_fk`,
  );
}

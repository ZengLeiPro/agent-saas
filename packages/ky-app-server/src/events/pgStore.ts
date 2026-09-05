/**
 * §3.7 安装实例状态与事件去重的 PostgreSQL 实现。
 *
 * 「去重记录、状态变更、ack」在**同一个事务**里提交：任一步失败整体回滚，
 * 平台重试时不会出现「状态变了但 ack 丢了」或反过来的半截状态。
 */
import type { InstallationState, PlatformEventAck } from '@kaiyan/ky-app-contract';

import type { Pool } from 'pg';

import type { InstallationStateRecord, InstallationStateStore } from './store.js';

export class PgInstallationStateStore implements InstallationStateStore {
  constructor(private readonly pool: Pool) {}

  async getState(): Promise<InstallationStateRecord> {
    const result = await this.pool.query<{ state: InstallationState; state_version: string }>(
      'SELECT state, state_version FROM ky_app_installation_state WHERE id = 1',
    );
    if (result.rowCount !== 1) return { state: 'enabled', stateVersion: 0 };
    return {
      state: result.rows[0].state,
      stateVersion: Number(result.rows[0].state_version),
    };
  }

  async findAck(eventId: string): Promise<PlatformEventAck | null> {
    const result = await this.pool.query<{ ack: PlatformEventAck }>(
      'SELECT ack FROM ky_app_event_ack WHERE event_id = $1',
      [eventId],
    );
    return result.rowCount === 1 ? result.rows[0].ack : null;
  }

  async commit(input: {
    eventId: string;
    ack: PlatformEventAck;
    state: InstallationStateRecord;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ky_app_event_ack (event_id, ack) VALUES ($1, $2::jsonb)
         ON CONFLICT (event_id) DO NOTHING`,
        [input.eventId, JSON.stringify(input.ack)],
      );
      await client.query(
        `INSERT INTO ky_app_installation_state (id, state, state_version, updated_at)
         VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state,
                                        state_version = EXCLUDED.state_version,
                                        updated_at = EXCLUDED.updated_at`,
        [input.state.state, input.state.stateVersion],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

import { z } from 'zod';
import type { GovernancePgPool } from '../../data/governance-schema/index.js';
import { governanceTablePrefix } from '../../data/governance-schema/index.js';
import { KyAppSystemConflictError } from '../systems/types.js';
import { assertBaseUrl, assertOrigin } from '../installations/service.js';
import type { KyAppPlatformConfig } from '../config.js';

export const connectionSettingsSchema = z
  .object({
    baseUrl: z.string().trim().max(500),
    origin: z.string().trim().max(500),
    diagnostic: z
      .object({
        readOnlyCapabilityId: z.string().min(1).max(64),
        readOnlyInput: z.record(z.string(), z.unknown()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConnectionSettings = z.infer<typeof connectionSettingsSchema>;
export interface ConnectionSettingsRecord {
  settings: ConnectionSettings;
  version: number;
}

export function connectionAddress(template: string, tenantId: string, systemId: string): string {
  return template.replaceAll('{tenantId}', tenantId).replaceAll('{systemId}', systemId);
}
export function validateConnectionSettings(
  settings: ConnectionSettings,
  config: KyAppPlatformConfig,
) {
  if (Boolean(settings.baseUrl) !== Boolean(settings.origin))
    throw new KyAppSystemConflictError('默认服务地址和页面地址必须同时配置，或同时留空');
  if (settings.baseUrl) {
    assertBaseUrl(connectionAddress(settings.baseUrl, 'example', 'example'), config);
    assertOrigin(connectionAddress(settings.origin, 'example', 'example'));
    // URL 会对未知占位符进行编码；明确拒绝，避免发布不可解析的模板。
    if (/[{}]/u.test(connectionAddress(settings.baseUrl + settings.origin, 'example', 'example')))
      throw new KyAppSystemConflictError('地址仅支持 {tenantId} 和 {systemId} 占位符');
  }
}

export class PgKyAppConnectionSettingsStore {
  private readonly table: string;
  constructor(
    private readonly pool: GovernancePgPool,
    prefix?: string,
  ) {
    this.table = `${governanceTablePrefix(prefix)}_ky_app_connection_settings`;
  }
  async get(systemId: string): Promise<ConnectionSettingsRecord> {
    const result = await this.pool.query(
      `SELECT settings_json,version FROM ${this.table} WHERE system_id=$1`,
      [systemId],
    );
    const row = result.rows[0];
    return row
      ? {
          settings: connectionSettingsSchema.parse(row.settings_json),
          version: Number(row.version),
        }
      : { settings: { baseUrl: '', origin: '' }, version: 0 };
  }
  async save(
    systemId: string,
    settings: ConnectionSettings,
    expectedVersion: number,
    actor: string,
  ) {
    const result =
      expectedVersion === 0
        ? await this.pool.query(
            `INSERT INTO ${this.table} (system_id,settings_json,updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT DO NOTHING RETURNING version`,
            [systemId, JSON.stringify(settings), actor],
          )
        : await this.pool.query(
            `UPDATE ${this.table} SET settings_json=$2::jsonb,version=version+1,updated_by=$3,updated_at=NOW() WHERE system_id=$1 AND version=$4 RETURNING version`,
            [systemId, JSON.stringify(settings), actor, expectedVersion],
          );
    if (!result.rows[0]) throw new KyAppSystemConflictError('接入配置已变化，请刷新后重试');
    return { settings, version: Number(result.rows[0].version) };
  }
}

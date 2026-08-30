export function governanceV34Statements(prefix: string): string[] {
  const accounts = `${prefix}_agent_dws_accounts`;
  const inbox = `${prefix}_agent_dws_event_inbox`;
  const runs = `${prefix}_runs`;
  const authSessions = `${prefix}_agent_dws_auth_sessions`;
  const sources = `${prefix}_context_sources`;
  const collections = `${prefix}_context_collections`;
  const partitions = `${prefix}_context_sync_partitions`;
  const accountRequiresIdentityRepair = `(
    account.profile_id IS NULL OR account.corp_id IS NULL OR account.dingtalk_user_id IS NULL
    OR BTRIM(account.profile_id)='' OR BTRIM(account.corp_id)='' OR BTRIM(account.dingtalk_user_id)=''
    OR BTRIM(account.profile_id)<>BTRIM(account.corp_id)||':'||BTRIM(account.dingtalk_user_id)
  )`;
  return [
    `ALTER TABLE ${accounts} ADD COLUMN IF NOT EXISTS identity_updated_at TIMESTAMPTZ`,
    `UPDATE ${accounts} SET identity_updated_at=updated_at WHERE identity_updated_at IS NULL`,
    `ALTER TABLE ${accounts} ALTER COLUMN identity_updated_at SET DEFAULT NOW(),
      ALTER COLUMN identity_updated_at SET NOT NULL`,
    `DO $$ BEGIN
      IF to_regclass('${authSessions}') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE ${authSessions} AS auth_session
          SET status='failed',error_code='authorization_interrupted_by_upgrade',
            error_message='钉钉授权因服务升级中断，请重新授权',
            authorization_url=NULL,user_code=NULL,completed_at=NOW(),updated_at=NOW()
          WHERE auth_session.status IN ('starting','awaiting_user')
            AND EXISTS (
              SELECT 1 FROM ${accounts} AS account
              WHERE account.tenant_id=auth_session.tenant_id
                AND account.account_id=auth_session.user_id
                AND account.status = 'authorizing'
            )
        $migration$;
      END IF;
    END $$`,
    `UPDATE ${sources} AS source
      SET status='disabled',revision=revision+1,updated_at=NOW()
      WHERE source.kind='dws' AND source.status='active'
        AND EXISTS (
          SELECT 1 FROM ${accounts} AS account
          WHERE account.tenant_id=source.tenant_id
            AND account.account_id=source.config_json->>'accountId'
            AND ${accountRequiresIdentityRepair}
        )`,
    `UPDATE ${collections} AS collection
      SET status='disabled',revision=revision+1,updated_at=NOW()
      WHERE collection.status='active'
        AND EXISTS (
          SELECT 1 FROM ${sources} AS source
          JOIN ${accounts} AS account
            ON account.tenant_id=source.tenant_id
            AND account.account_id=source.config_json->>'accountId'
          WHERE source.tenant_id=collection.tenant_id
            AND source.source_id=collection.source_id
            AND source.kind='dws'
            AND ${accountRequiresIdentityRepair}
        )`,
    `UPDATE ${partitions} AS sync_partition
      SET status='idle',lease_owner=NULL,lease_fence=lease_fence+1,
        lease_expires_at=NULL,updated_at=NOW()
      WHERE (sync_partition.status='syncing' OR sync_partition.lease_owner IS NOT NULL
        OR sync_partition.lease_expires_at IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM ${sources} AS source
          JOIN ${accounts} AS account
            ON account.tenant_id=source.tenant_id
            AND account.account_id=source.config_json->>'accountId'
          WHERE source.tenant_id=sync_partition.tenant_id
            AND source.source_id=sync_partition.source_id
            AND source.kind='dws'
            AND ${accountRequiresIdentityRepair}
        )`,
    `UPDATE ${accounts} AS account
      SET
        corp_id=BTRIM(SPLIT_PART(account.profile_id,':',1)),
          dingtalk_user_id=BTRIM(SUBSTRING(account.profile_id FROM POSITION(':' IN account.profile_id)+1)),
          runtime_status='stopped',runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=account.revision+1,updated_at=NOW(),updated_by='system:dws-profile-v34'
      WHERE account.status<>'authorizing'
        AND account.profile_id IS NOT NULL AND POSITION(':' IN account.profile_id)>0
        AND NULLIF(BTRIM(SPLIT_PART(account.profile_id,':',1)),'') IS NOT NULL
        AND NULLIF(BTRIM(SUBSTRING(account.profile_id FROM POSITION(':' IN account.profile_id)+1)),'') IS NOT NULL
        AND (NULLIF(BTRIM(account.corp_id),'') IS NULL
          OR BTRIM(account.corp_id)=BTRIM(SPLIT_PART(account.profile_id,':',1)))
        AND (NULLIF(BTRIM(account.dingtalk_user_id),'') IS NULL
          OR BTRIM(account.dingtalk_user_id)=BTRIM(SUBSTRING(
            account.profile_id FROM POSITION(':' IN account.profile_id)+1
          )))
        AND (
          account.corp_id IS DISTINCT FROM BTRIM(SPLIT_PART(account.profile_id,':',1))
          OR account.dingtalk_user_id IS DISTINCT FROM BTRIM(SUBSTRING(
            account.profile_id FROM POSITION(':' IN account.profile_id)+1
          ))
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${accounts} AS existing
          WHERE existing.tenant_id=account.tenant_id
            AND existing.account_id<>account.account_id
            AND BTRIM(existing.corp_id)=BTRIM(SPLIT_PART(account.profile_id,':',1))
            AND BTRIM(existing.dingtalk_user_id)=BTRIM(SUBSTRING(
              account.profile_id FROM POSITION(':' IN account.profile_id)+1
            ))
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${accounts} AS candidate
          WHERE candidate.tenant_id=account.tenant_id
            AND candidate.account_id<account.account_id
            AND POSITION(':' IN candidate.profile_id)>0
            AND BTRIM(SPLIT_PART(candidate.profile_id,':',1))
              =BTRIM(SPLIT_PART(account.profile_id,':',1))
            AND BTRIM(SUBSTRING(candidate.profile_id FROM POSITION(':' IN candidate.profile_id)+1))
              =BTRIM(SUBSTRING(account.profile_id FROM POSITION(':' IN account.profile_id)+1))
        )`,
    `UPDATE ${accounts} AS account
      SET corp_id=BTRIM(account.profile_id),
          runtime_status='stopped',runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=account.revision+1,updated_at=NOW(),updated_by='system:dws-profile-v34'
      WHERE account.status<>'authorizing'
        AND NULLIF(BTRIM(account.profile_id),'') IS NOT NULL
        AND POSITION(':' IN account.profile_id)=0
        AND NULLIF(BTRIM(account.corp_id),'') IS NULL
        AND (
          NULLIF(BTRIM(account.dingtalk_user_id),'') IS NULL
          OR (
            NOT EXISTS (
              SELECT 1 FROM ${accounts} AS existing
              WHERE existing.tenant_id=account.tenant_id
                AND existing.account_id<>account.account_id
                AND BTRIM(existing.corp_id)=BTRIM(account.profile_id)
                AND BTRIM(existing.dingtalk_user_id)=BTRIM(account.dingtalk_user_id)
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${accounts} AS candidate
              WHERE candidate.tenant_id=account.tenant_id
                AND candidate.account_id<account.account_id
                AND BTRIM(candidate.profile_id)=BTRIM(account.profile_id)
                AND BTRIM(candidate.dingtalk_user_id)=BTRIM(account.dingtalk_user_id)
            )
          )
        )`,
    `UPDATE ${accounts} AS account
      SET profile_id=BTRIM(account.corp_id) || ':' || BTRIM(account.dingtalk_user_id),
          corp_id=BTRIM(account.corp_id),dingtalk_user_id=BTRIM(account.dingtalk_user_id),
          runtime_status='stopped',runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=account.revision+1,updated_at=NOW(),updated_by='system:dws-profile-v34'
      WHERE account.status<>'authorizing'
        AND account.profile_id IS NOT NULL AND POSITION(':' IN account.profile_id)=0
        AND NULLIF(BTRIM(account.corp_id),'') IS NOT NULL
        AND NULLIF(BTRIM(account.dingtalk_user_id),'') IS NOT NULL
        AND BTRIM(account.profile_id)=BTRIM(account.corp_id)
        AND NOT EXISTS (
          SELECT 1 FROM ${accounts} AS existing
          WHERE existing.tenant_id=account.tenant_id
            AND existing.account_id<>account.account_id
            AND BTRIM(existing.corp_id)=BTRIM(account.corp_id)
            AND BTRIM(existing.dingtalk_user_id)=BTRIM(account.dingtalk_user_id)
        )`,
    `DO $$ BEGIN
      IF to_regclass('${inbox}') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE ${inbox} AS inbox
          SET payload_json=jsonb_set(
                inbox.payload_json,'{accountIdentity}',jsonb_build_object(
                  'profileId',account.profile_id,
                  'corpId',account.corp_id,
                  'dingtalkUserId',account.dingtalk_user_id
                ),TRUE
              ),updated_at=NOW()
          FROM ${accounts} AS account
          WHERE inbox.tenant_id=account.tenant_id AND inbox.account_id=account.account_id
            AND inbox.state IN ('pending','processing','retry_wait','reply_pending')
            AND inbox.payload_json->>'schemaVersion'='1'
            AND NOT (inbox.payload_json ? 'accountIdentity')
            AND account.status='active'
            AND account.profile_id=account.corp_id || ':' || account.dingtalk_user_id
            AND account.identity_updated_at <= inbox.created_at
        $migration$;
      END IF;
    END $$`,
    `DO $$ BEGIN
      IF to_regclass('${runs}') IS NOT NULL THEN
        EXECUTE $migration$
          UPDATE ${runs} AS runtime_run
          SET metadata=jsonb_set(
            runtime_run.metadata,'{dwsCompletionRoute}',
            runtime_run.metadata->'dwsCompletionRoute' || jsonb_build_object(
              'profileId',account.profile_id,
              'corpId',account.corp_id,
              'dingtalkUserId',account.dingtalk_user_id
            ),TRUE
          )
          FROM ${accounts} AS account, ${runs} AS parent_run
          WHERE runtime_run.metadata->>'backgroundTask'='true'
            AND runtime_run.metadata->>'parentChannel'='dingtalk'
            AND jsonb_typeof(runtime_run.metadata->'dwsCompletionRoute')='object'
            AND NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'profileId')
            AND NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'corpId')
            AND NOT (runtime_run.metadata->'dwsCompletionRoute' ? 'dingtalkUserId')
            AND runtime_run.metadata->'dwsCompletionRoute'->>'accountId'=account.account_id
            AND runtime_run.tenant_id=account.tenant_id
            AND parent_run.run_id=runtime_run.metadata->>'parentRunId'
            AND parent_run.tenant_id=runtime_run.tenant_id
            AND parent_run.channel='dingtalk'
            AND parent_run.metadata->>'backgroundTask' IS DISTINCT FROM 'true'
            AND account.status='active'
            AND account.profile_id=account.corp_id || ':' || account.dingtalk_user_id
            AND account.identity_updated_at <= parent_run.requested_at
        $migration$;
      END IF;
    END $$`,
    `UPDATE ${accounts}
      SET status='error',runtime_status='error',
          last_error='dws_profile_identity_reauthorization_required',
          runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=revision+1,updated_at=NOW(),updated_by='system:dws-profile-v34'
      WHERE status='active' AND (
        NULLIF(BTRIM(profile_id),'') IS NULL
        OR NULLIF(BTRIM(corp_id),'') IS NULL
        OR NULLIF(BTRIM(dingtalk_user_id),'') IS NULL
        OR profile_id IS DISTINCT FROM corp_id || ':' || dingtalk_user_id
      )`,
    `UPDATE ${accounts}
      SET status='error',runtime_status='error',
          last_error='authorization_interrupted_by_upgrade',
          runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=revision+1,updated_at=NOW(),updated_by='system:dws-authorizing-v34'
      WHERE status='authorizing'`,
    `ALTER TABLE ${accounts}
      DROP CONSTRAINT IF EXISTS ${prefix}_adws_active_identity_ck`,
    `ALTER TABLE ${accounts}
      ADD CONSTRAINT ${prefix}_adws_active_identity_ck CHECK (
        status<>'active' OR (
          NULLIF(BTRIM(profile_id),'') IS NOT NULL
          AND NULLIF(BTRIM(corp_id),'') IS NOT NULL
          AND NULLIF(BTRIM(dingtalk_user_id),'') IS NOT NULL
          AND profile_id=corp_id || ':' || dingtalk_user_id
        )
      )`,
  ];
}

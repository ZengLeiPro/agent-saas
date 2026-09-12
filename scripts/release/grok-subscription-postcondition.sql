WITH suffixes(kind, suffix, column_count) AS (
  VALUES ('state', '_grok_credential_runtime_state', 6),
         ('journal', '_grok_credential_refresh_journal', 3)
), names AS (
  SELECT kind, column_count,
    lower((CASE WHEN length($1::text) <= 44 - length(suffix) THEN $1::text
      ELSE 'g' || left(encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), 43 - length(suffix))
    END) || suffix) AS table_name
  FROM suffixes
), relations AS (
  SELECT n.*, c.oid FROM names n
  LEFT JOIN pg_class c ON c.oid = to_regclass(format('%I.%I', current_schema(), n.table_name))
    AND c.relkind = 'r' AND c.relpersistence = 'p'
), expected(kind, column_name, data_type, not_null) AS (
  VALUES ('state','credential_ref','text',true), ('state','availability','text',true),
    ('state','credential_generation','int8',true), ('state','cooldown_until','timestamptz',false),
    ('state','last_failure_code','text',false), ('state','updated_at','timestamptz',true),
    ('journal','credential_ref','text',true), ('journal','credential_generation','int8',true),
    ('journal','started_at','timestamptz',true)
)
SELECT
  (SELECT count(*) = 2 AND bool_and(oid IS NOT NULL) FROM relations)
  AND NOT EXISTS (
    SELECT 1 FROM expected e JOIN relations r USING(kind)
    LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = e.column_name
      AND a.attnum > 0 AND NOT a.attisdropped
    WHERE a.attname IS NULL OR a.atttypid <> e.data_type::regtype OR a.attnotnull <> e.not_null
  )
  AND NOT EXISTS (
    SELECT 1 FROM relations r WHERE
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped) <> r.column_count
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='credential_ref'
        WHERE c.conrelid=r.oid AND c.contype='p' AND c.convalidated AND c.conkey=ARRAY[a.attnum]
      )
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
    WHERE r.kind='state' AND c.contype='c' AND c.convalidated
      AND regexp_replace(pg_get_constraintdef(c.oid), '\s', '', 'g') =
        'CHECK((availability=ANY(ARRAY[''available''::text,''quota_cooldown''::text,''auth_unavailable''::text])))'
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
    WHERE r.kind='journal' AND c.contype='c' AND c.convalidated
      AND regexp_replace(pg_get_constraintdef(c.oid), '\s', '', 'g') = 'CHECK((credential_generation>0))'
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname='credential_generation'
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE r.kind='state' AND pg_get_expr(d.adbin,d.adrelid)='0'
  )
  AND (SELECT count(*)=2 FROM relations r
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname=CASE WHEN r.kind='state' THEN 'updated_at' ELSE 'started_at' END
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE pg_get_expr(d.adbin,d.adrelid)='now()')
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_index i ON i.indrelid=r.oid
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname='cooldown_until'
    WHERE r.kind='state' AND idx.relname=r.table_name||'_cooldown_idx'
      AND i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnkeyatts=1
      AND i.indkey::text=a.attnum::text AND i.indpred IS NULL AND i.indexprs IS NULL
  ) AS ok

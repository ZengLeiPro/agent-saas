import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { PgRunStore } from './runStore.js';
import { PgSessionAutomationStore,commandDigest } from './sessionAutomationStore.js';
const {Pool}=pg;
const url=process.env.TEST_DATABASE_URL;
const describePg=url?describe:describe.skip;

describePg('session automation creation receipt saga on real PostgreSQL',()=>{
 const prefix=`automation_saga_${randomUUID().replaceAll('-','').slice(0,10)}`;
 let pool:InstanceType<typeof Pool>;let store:PgSessionAutomationStore;
 beforeAll(async()=>{pool=new Pool({connectionString:url!,max:4});const runs=new PgRunStore({pool,tablePrefix:prefix});await runs.init();store=new PgSessionAutomationStore(pool,prefix,runs.runsTable);await store.init();},30000);
 afterAll(async()=>{if(!pool)return;const tables=Object.values(store.tables).map(name=>`DROP TABLE IF EXISTS ${name} CASCADE`).join(';');await pool.query(tables);await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs CASCADE`);await pool.end();},30000);
 it('recovers prepared/file_ready with one stable session and rejects a different digest',async()=>{
  const request={command:'/loop adaptive -- continue',sessionId:null,attachments:[]};const digest=commandDigest(request);const sessionId=randomUUID();
  expect(await store.prepareCommandSession({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-crash',commandDigest:digest,canonicalRequest:request,sessionId})).toBe(sessionId);
  const restarted=new PgSessionAutomationStore(pool,prefix,`${prefix}_runs`);
  expect(await restarted.prepareCommandSession({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-crash',commandDigest:digest,canonicalRequest:request,sessionId:randomUUID()})).toBe(sessionId);
  await restarted.markCommandFileReady({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-crash',commandDigest:digest,sessionId});
  expect(await restarted.getCommandReceipt('tenant-a','user-a','msg-crash')).toMatchObject({state:'file_ready',sessionId,canonicalRequest:request,sessionMetaCreated:false});
  await expect(restarted.prepareCommandSession({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-crash',commandDigest:commandDigest({...request,command:'different'}),canonicalRequest:{...request,command:'different'},sessionId:randomUUID()})).rejects.toMatchObject({code:'CONFLICT'});
 });
 it('upgrades the legacy commands table with every saga column and constraint idempotently',async()=>{
  const legacyPrefix=`${prefix}_legacy`;const runs=new PgRunStore({pool,tablePrefix:legacyPrefix});await runs.init();
  const legacyStore=new PgSessionAutomationStore(pool,legacyPrefix,runs.runsTable);
  await pool.query(`CREATE TABLE ${legacyStore.tables.commands}(tenant_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,client_message_id TEXT NOT NULL,session_id TEXT NOT NULL,command_digest TEXT NOT NULL,automation_id UUID,response JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,owner_user_id,client_message_id))`);
  await pool.query(`INSERT INTO ${legacyStore.tables.commands}(tenant_id,owner_user_id,client_message_id,session_id,command_digest) VALUES('t','u','m',$1,'d')`,[randomUUID()]);
  await legacyStore.init();await legacyStore.init();
  const columns=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1`,[legacyStore.tables.commands]);
  expect(columns.rows.map(row=>row.column_name)).toEqual(expect.arrayContaining(['canonical_request','response_cursor','state','last_error','failure_code','session_meta_created','updated_at']));
  expect(await legacyStore.getCommandReceipt('t','u','m')).toMatchObject({state:'committed',sessionMetaCreated:false});
  await pool.query(Object.values(legacyStore.tables).map(name=>`DROP TABLE IF EXISTS ${name} CASCADE`).join(';'));await pool.query(`DROP TABLE IF EXISTS ${legacyPrefix}_runs CASCADE`);
 });
 it('persists compensated failures and retries return the authoritative failure',async()=>{
  const request={command:'/goal -- done',sessionId:null,attachments:[]};const digest=commandDigest(request);const sessionId=randomUUID();
  await store.prepareCommandSession({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-denied',commandDigest:digest,canonicalRequest:request,sessionId});
  await store.markCommandFileReady({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-denied',commandDigest:digest,sessionId,sessionMetaCreated:true});
  expect(await store.compensateCommand({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-denied',commandDigest:digest,error:Object.assign(new Error('denied'),{code:'GOVERNANCE_DENIED'})})).toEqual({sessionMetaCreated:true});
  await expect(store.prepareCommandSession({tenantId:'tenant-a',ownerUserId:'user-a',clientMessageId:'msg-denied',commandDigest:digest,canonicalRequest:request,sessionId:randomUUID()})).rejects.toMatchObject({message:'denied'});
  expect(await store.getCommandReceipt('tenant-a','user-a','msg-denied')).toMatchObject({state:'compensated',lastError:'denied',sessionMetaCreated:true});
 });
 it('commits the event cursor in the receipt and reads snapshot/cursor from one statement',async()=>{
  const id={tenantId:'tenant-a',ownerUserId:'user-a',sessionId:randomUUID()};const request={command:'create'};const digest=commandDigest(request);
  const committed=await store.tx(async client=>{const snapshot=await store.create(client,id,{kind:'loop',mode:'adaptive',prompt:'continue',budget:{}} as never,new Date());const response={result:'created',snapshot};const cursor=await store.recordCommand(client,id,id.sessionId,'msg-commit',digest,snapshot.automationId,response,request);return{snapshot,cursor};});
  const receipt=await store.getCommandReceipt(id.tenantId,id.ownerUserId,'msg-commit');const view=await store.getSessionAutomationView(id.tenantId,id.sessionId,id.ownerUserId);
  expect(receipt).toMatchObject({state:'committed',cursor:committed.cursor,automationId:committed.snapshot.automationId});expect(view).toMatchObject({snapshot:{automationId:committed.snapshot.automationId},cursor:committed.cursor});
  expect(committed.cursor).not.toBeNull();
 });
});

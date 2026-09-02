import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateBuildEvidence } from '../../scripts/mobile-release-evidence.mjs';

export const ACTIONS = Object.freeze(['fresh_install','same_version_reinstall','n_minus_1_to_n_overlay','cache_v1_to_v2','expired_token','revoked_token','old_pending_same_protocol','old_pending_protocol_upgrade','server_epoch_restart','store_pause_kill_compat_hotfix','enterprise_signed_rollback']);
const SHA=/^[0-9a-f]{40}$/;const DIGEST=/^sha256:[0-9a-f]{64}$/;const HASH=/^[0-9a-f]{64}$/;const TIME=(v)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const required=(object,fields,label)=>{if(!object||typeof object!=='object'||Array.isArray(object))throw new Error(`${label} must be object`);for(const field of fields)if(object[field]===undefined||object[field]==='')throw new Error(`${label} missing ${field}`);};

export function validateRehearsalPlan(plan){
 required(plan,['schemaVersion','planId','cases'],'plan');if(plan.schemaVersion!=='1.0.0'||plan.planId!=='M70-02'||!Array.isArray(plan.cases)||plan.cases.length!==21)throw new Error('M70-02 plan cardinality/schema invalid');
 const ids=new Set();const coverage=new Map();
 for(const item of plan.cases){required(item,['id','platform','action','installMethod','expectedOutcome','artifactSlots'],'case');if(ids.has(item.id))throw new Error(`duplicate case ${item.id}`);ids.add(item.id);if(!['ios','android'].includes(item.platform)||!ACTIONS.includes(item.action))throw new Error(`invalid case ${item.id}`);if(JSON.stringify(item.artifactSlots)!=='["previous","current"]')throw new Error(`artifact slots invalid ${item.id}`);coverage.set(`${item.platform}:${item.action}`,true);}
 for(const action of ACTIONS.filter((item)=>item!=='enterprise_signed_rollback'))for(const platform of ['ios','android'])if(!coverage.has(`${platform}:${action}`))throw new Error(`missing ${platform} ${action}`);
 if(!coverage.has('android:enterprise_signed_rollback'))throw new Error('missing Android enterprise rollback');
 return {caseCount:plan.cases.length,ios:plan.cases.filter((item)=>item.platform==='ios').length,android:plan.cases.filter((item)=>item.platform==='android').length};
}
function artifact(value,label){
 required(value,['profile','sourceSha','digest','appId','version','buildNumber','versionCode','signerDigest','evidenceKind','m60EvidenceRef'],label);
 if(!SHA.test(value.sourceSha)||!DIGEST.test(value.digest)||!DIGEST.test(value.signerDigest))throw new Error(`${label} identity invalid`);
 if(value.profile==='ios-store'){if(!/^\d+$/.test(value.buildNumber)||value.versionCode!==null)throw new Error(`${label} iOS version identity invalid`);}else if(value.buildNumber!==null||!Number.isSafeInteger(value.versionCode)||value.versionCode<1)throw new Error(`${label} Android version identity invalid`);
 if(!['ios-store','android-store','android-enterprise'].includes(value.profile)||!['m60-verified-artifact','test-fixture'].includes(value.evidenceKind))throw new Error(`${label} authority invalid`);
}
function evidenceFile(value,label){required(value,['path','sha256'],label);if(!HASH.test(value.sha256)||path.isAbsolute(value.path)||value.path.includes('..'))throw new Error(`${label} invalid`);}
async function verifyFile(root,value,label){const resolved=path.resolve(root,value.path);if(!resolved.startsWith(`${path.resolve(root)}${path.sep}`))throw new Error(`${label} escapes evidence root`);const info=await stat(resolved);if(!info.isFile())throw new Error(`${label} not file`);const actual=createHash('sha256').update(await readFile(resolved)).digest('hex');if(actual!==value.sha256)throw new Error(`${label} hash mismatch`);}

export async function validateRehearsalEvidence(bundle,{plan,evidenceRoot,releasePublicKeys,releaseEvidenceValidator}={}){
 const summary=validateRehearsalPlan(plan);required(bundle,['schemaVersion','planId','mode','explicitContractMock','commitSha','previousCommitSha','caseResults'],'evidence');
 if(bundle.schemaVersion!=='1.0.0'||bundle.planId!=='M70-02'||!['contract','production'].includes(bundle.mode)||!SHA.test(bundle.commitSha)||!SHA.test(bundle.previousCommitSha)||bundle.commitSha===bundle.previousCommitSha)throw new Error('evidence identity invalid');
 if(!Array.isArray(bundle.caseResults)||bundle.caseResults.length!==plan.cases.length)throw new Error('one result per plan case required');
 if(bundle.mode==='production'&&!evidenceRoot)throw new Error('production evidenceRoot required');if(bundle.mode==='production'&&bundle.explicitContractMock)throw new Error('production cannot be contract mock');if(bundle.mode==='contract'&&!bundle.explicitContractMock)throw new Error('contract fixture must be explicit');
 const planById=new Map(plan.cases.map((item)=>[item.id,item]));const seen=new Set();const receipts=new Set();const runs=new Set();const releaseCache=new Map();
 const validateRelease=releaseEvidenceValidator??((document)=>validateBuildEvidence(document,{publicKeys:releasePublicKeys}));
 async function validateM60Reference(value){if(releaseCache.has(value.m60EvidenceRef))return releaseCache.get(value.m60EvidenceRef);if(!releaseEvidenceValidator&&!releasePublicKeys)throw new Error('production M60 release public keys required');const file=path.resolve(evidenceRoot,value.m60EvidenceRef);if(!file.startsWith(`${path.resolve(evidenceRoot)}${path.sep}`))throw new Error('M60 evidence path escapes root');const document=JSON.parse(await readFile(file,'utf8'));validateRelease(document);releaseCache.set(value.m60EvidenceRef,document);return document;}
 for(const result of bundle.caseResults){
  required(result,['caseId','commitSha','device','previousArtifact','currentArtifact','installMethod','action','startedAt','completedAt','result','observedOutcome','receiptId','testRunId','log','screenshot'],'result');
  const planned=planById.get(result.caseId);if(!planned||seen.has(result.caseId))throw new Error(`unknown/repeated case ${result.caseId}`);seen.add(result.caseId);
  if(result.commitSha!==bundle.commitSha)throw new Error('cross SHA result');if(result.action!==planned.action||result.installMethod!==planned.installMethod)throw new Error('action/install method mismatch');
  required(result.device,['platform','evidenceKind','provider','deviceId','model','osVersion'],'device');if(result.device.platform!==planned.platform)throw new Error('device platform mismatch');
  if(!TIME(result.startedAt)||!TIME(result.completedAt)||Date.parse(result.completedAt)<Date.parse(result.startedAt))throw new Error('action time invalid');
  if(!['passed','failed','blocked'].includes(result.result))throw new Error('result invalid');if(receipts.has(result.receiptId)||runs.has(result.testRunId))throw new Error('receipt replay');receipts.add(result.receiptId);runs.add(result.testRunId);
  artifact(result.previousArtifact,'previous artifact');artifact(result.currentArtifact,'current artifact');evidenceFile(result.log,'log');evidenceFile(result.screenshot,'screenshot');
  if(result.currentArtifact.sourceSha!==bundle.commitSha)throw new Error('current artifact cross SHA');if(result.previousArtifact.sourceSha!==bundle.previousCommitSha)throw new Error('previous artifact cross SHA');
  if(result.currentArtifact.appId!==result.previousArtifact.appId)throw new Error('appId mismatch');if(result.currentArtifact.signerDigest!==result.previousArtifact.signerDigest)throw new Error('wrong signer upgrade chain');
  const expectedProfile=planned.platform==='ios'?'ios-store':planned.action==='enterprise_signed_rollback'?'android-enterprise':'android-store';if(result.currentArtifact.profile!==expectedProfile||result.previousArtifact.profile!==expectedProfile)throw new Error('artifact profile mismatch');
  if(['n_minus_1_to_n_overlay','store_pause_kill_compat_hotfix','enterprise_signed_rollback'].includes(planned.action)){const before=planned.platform==='ios'?Number(result.previousArtifact.buildNumber):result.previousArtifact.versionCode;const after=planned.platform==='ios'?Number(result.currentArtifact.buildNumber):result.currentArtifact.versionCode;if(after<=before)throw new Error('version regression/store downgrade forbidden');}
  if(planned.action==='old_pending_same_protocol'&&!/^ack_(confirmed|unconfirmed)_no_replay$/.test(result.observedOutcome))throw new Error('same protocol pending must query ACK without replay');
  if(planned.action==='old_pending_protocol_upgrade'&&result.observedOutcome!=='failed_upgrade_no_replay')throw new Error('protocol upgrade pending must fail without replay');
  if(planned.action==='store_pause_kill_compat_hotfix'&&result.observedOutcome!=='rollout_paused_capability_killed_metrics_verified_higher_version_hotfix')throw new Error('store downgrade contract rejected');
  if(planned.action==='enterprise_signed_rollback'&&result.observedOutcome!=='signed_verified_audited_replay_ledgered')throw new Error('enterprise audit missing');
  if(bundle.mode==='production'){
   if(result.device.evidenceKind!=='real-device')throw new Error('production accepts real device only');if(result.result!=='passed')throw new Error('production case must pass');
   for(const value of [result.previousArtifact,result.currentArtifact]){if(value.evidenceKind!=='m60-verified-artifact'||/^fixture:/i.test(value.m60EvidenceRef))throw new Error('production accepts M60 real artifacts only');const release=await validateM60Reference(value);if(release.commitOid!==value.sourceSha)throw new Error('M60 evidence cross SHA');const profile=release.profiles?.find((item)=>item.profile===value.profile);if(!profile||profile.artifactSha256!==value.digest||profile.appId!==value.appId||profile.version!==value.version||profile.signerFingerprint!==value.signerDigest||String(profile.buildNumber??'')!==String(value.buildNumber??'')||profile.versionCode!==value.versionCode)throw new Error('M60 artifact binding mismatch');}
   await verifyFile(evidenceRoot,result.log,'log');await verifyFile(evidenceRoot,result.screenshot,'screenshot');
  }else if(result.device.evidenceKind!=='simulator'||result.currentArtifact.evidenceKind!=='test-fixture'||result.previousArtifact.evidenceKind!=='test-fixture')throw new Error('contract evidence must remain fixture/simulator');
 }
 return {...summary,mode:bundle.mode,passed:bundle.caseResults.filter((item)=>item.result==='passed').length};
}

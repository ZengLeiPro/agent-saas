import { describe, expect, it } from 'vitest';
import { evaluateFixtureClient, MOBILE_N_MINUS_ONE_N_FIXTURE, readNMinusOneFixture } from './contracts';
import { acceptMobilePolicyVersion, capabilityAllowed, evaluateMobileCompatibility, parseSignedMobileCompatibilityPolicy, type SignedMobileCompatibilityPolicy } from './policy';

function policy(overrides: Partial<SignedMobileCompatibilityPolicy> = {}): SignedMobileCompatibilityPolicy {
  return {schemaVersion:1,tenantId:'tenant-a',environment:'production',appId:'com.agentsaas.mobile',api:{min:2,max:3},cacheSchema:{min:1,max:2},minSupportedAppVersion:'1.9.0',disabledCapabilities:['voice'],blockReason:'update required',owner:'mobile-oncall',incident:'INC-7002',changeId:'CHG-7002',effectiveAt:'2026-09-01T08:00:00.000Z',expiresAt:'2026-09-01T10:00:00.000Z',version:7,nonce:'nonce-7',digest:'a'.repeat(64),signatureAlgorithm:'Ed25519',keyId:'key-7',signature:Buffer.alloc(64).toString('base64'),...overrides};
}
const client={tenantId:'tenant-a',environment:'production' as const,appId:'com.agentsaas.mobile',appVersion:'1.9.0',apiVersion:2,cacheSchemaVersion:2};

describe('M70-02 shared compatibility policy',()=>{
 it('allows N-1/N and kills only the named capability',()=>{const decision=evaluateMobileCompatibility(policy(),client,Date.parse('2026-09-01T09:00:00Z'));expect(decision.status).toBe('allowed');expect(capabilityAllowed(decision,'send')).toBe(true);expect(capabilityAllowed(decision,'voice')).toBe(false);});
 it('blocks N-2 with safe update/logout actions and preserves data',()=>{const decision=evaluateMobileCompatibility(policy(),{...client,apiVersion:1,appVersion:'1.8.9'},Date.parse('2026-09-01T09:00:00Z'));expect(decision).toMatchObject({status:'blocked',allowedActions:['logout','update'],preserveLocalData:true});});
 it('rejects cross tenant, old/replayed, expired and malformed policies',()=>{expect(()=>evaluateMobileCompatibility(policy(),{...client,tenantId:'tenant-b'},Date.parse('2026-09-01T09:00:00Z'))).toThrowError(expect.objectContaining({code:'POLICY_CROSS_TENANT'}));expect(()=>acceptMobilePolicyVersion(policy(),{highestVersion:7,acceptedDigests:[]})).toThrowError(expect.objectContaining({code:'POLICY_REPLAYED'}));expect(evaluateMobileCompatibility(policy(),client,Date.parse('2026-09-01T11:00:00Z'))).toMatchObject({status:'blocked',code:'POLICY_EXPIRED'});expect(()=>parseSignedMobileCompatibilityPolicy({...policy(),token:'must-not-leak'})).toThrow();});
});

describe('M70-02 shared N-1/N fixture',()=>{
 const fixture=MOBILE_N_MINUS_ONE_N_FIXTURE;
 it('reads old submission/sync/cache fields and safely ignores unknown N fields',()=>{expect(readNMinusOneFixture(fixture)).toEqual({apiVersion:2,cacheSchemaVersion:1,submission:{clientMsgId:'m70-02-old-client-1',draft:'old client submission'},sync:{epoch:'epoch-n',seq:9,events:[{type:'message'}]},cache:{sessions:[{id:'session-n-minus-one',title:'known title'}]}});expect(evaluateFixtureClient(policy(),'1.9.0',fixture).status).toBe('allowed');});
 it('fails N-2 closed with update action',()=>{expect(evaluateFixtureClient(policy(),'1.9.0',{...fixture,apiVersion:1})).toMatchObject({status:'blocked',allowedActions:['logout','update']});});
});

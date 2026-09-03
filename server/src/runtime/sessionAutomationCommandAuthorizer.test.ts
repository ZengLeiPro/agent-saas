import { describe,expect,it,vi } from 'vitest';
import { resolveUserCwd } from '../workspace/resolver.js';
import { GovernedSessionAutomationCommandAuthorizer } from './sessionAutomationCommandAuthorizer.js';

const identity={tenantId:'tenant-a',ownerUserId:'user-a',sessionId:'session-a'};
const agentCwd='/srv/workspaces';
const session={sessionId:'session-a',tenantId:'tenant-a',userId:'user-a',username:'alice',userRole:'user' as const,channel:'web',transcriptPath:'/x',cwd:resolveUserCwd(agentCwd,{id:'user-a',username:'alice',role:'user',tenantId:'tenant-a'}),workspaceId:'session-a',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};

describe('GovernedSessionAutomationCommandAuthorizer',()=>{
 it('fails closed when authoritative entitlement/assignment/quota readiness denies execution',async()=>{
  const authorize=new GovernedSessionAutomationCommandAuthorizer({agentCwd,sessionCatalog:{get:vi.fn(async()=>session)},preflight:{preflight:vi.fn(async()=>({accessDecision:{verdict:'deny',reasonCode:'ASSIGNMENT_DENIED'},readiness:{ready:false,blockers:[{code:'QUOTA_EXHAUSTED'}]}}))} as never});
  await expect(authorize.authorize(identity)).rejects.toMatchObject({code:'GOVERNANCE_DENIED'});
 });
 it('returns the authoritative tenant credit cap and fails closed when billing policy is unavailable',async()=>{
  const allowed={accessDecision:{verdict:'allow'},readiness:{ready:true,blockers:[]}};
  const billing={getAutomationCreditCap:vi.fn(async()=>12.5)};
  const authorize=new GovernedSessionAutomationCommandAuthorizer({agentCwd,sessionCatalog:{get:vi.fn(async()=>session)},preflight:{preflight:vi.fn(async()=>allowed)} as never,billing});
  await expect(authorize.authorize(identity)).resolves.toEqual({maxCredits:12.5});
  billing.getAutomationCreditCap.mockRejectedValueOnce(new Error('down'));
  await expect(authorize.authorize(identity)).rejects.toMatchObject({code:'GOVERNANCE_UNAVAILABLE'});
 });
  it('fails closed when governance or workspace trust cannot be established',async()=>{
  const unavailable=new GovernedSessionAutomationCommandAuthorizer({agentCwd,sessionCatalog:{get:vi.fn(async()=>session)},preflight:{preflight:vi.fn(async()=>{throw new Error('down');})} as never});
  await expect(unavailable.authorize(identity)).rejects.toMatchObject({code:'GOVERNANCE_UNAVAILABLE'});
  const untrusted=new GovernedSessionAutomationCommandAuthorizer({agentCwd,sessionCatalog:{get:vi.fn(async()=>({...session,cwd:'/tmp/other'}))},preflight:{preflight:vi.fn()} as never});
  await expect(untrusted.authorize(identity)).rejects.toMatchObject({code:'GOVERNANCE_DENIED'});
 });
});

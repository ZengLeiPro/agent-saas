import { randomUUID } from 'node:crypto';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { RunPreflightService } from './runPreflight.js';
import type { SessionCatalog } from './sessionCatalog.js';
import type { AutomationIdentity } from './sessionAutomationStore.js';
import { SessionAutomationConflictError } from './sessionAutomationStore.js';
import type { SessionAutomationCommandAuthorizer } from './sessionAutomationCommandService.js';

/** Reuses the runtime's authoritative governance preflight and additionally binds it to trusted session metadata. */
export class GovernedSessionAutomationCommandAuthorizer implements SessionAutomationCommandAuthorizer {
  constructor(private readonly options:{
    preflight:Pick<RunPreflightService,'preflight'>;
    sessionCatalog:Pick<SessionCatalog,'get'>;
    agentCwd:string;
  }){}

  async authorize(id:AutomationIdentity):Promise<void>{
    const session=await this.options.sessionCatalog.get(id.sessionId).catch(()=>undefined);
    if(!session||session.tenantId!==id.tenantId||session.userId!==id.ownerUserId){
      throw new SessionAutomationConflictError('NOT_FOUND','session 不存在');
    }
    const expectedCwd=resolveUserCwd(this.options.agentCwd,{id:session.userId,username:session.username,role:session.userRole??'user',tenantId:session.tenantId});
    if(session.cwd!==expectedCwd||session.workspaceId!==id.sessionId){
      throw new SessionAutomationConflictError('GOVERNANCE_DENIED','workspace trust validation failed');
    }
    let result;
    try{
      result=await this.options.preflight.preflight({phase:'enqueue',runId:randomUUID(),sessionId:id.sessionId,userId:id.ownerUserId,tenantId:id.tenantId,...(session.orgAgentId?{orgAgentId:session.orgAgentId}:{}),...(session.executionRole?{executionRole:session.executionRole}:{})});
    }catch{
      throw new SessionAutomationConflictError('GOVERNANCE_UNAVAILABLE','automation governance unavailable');
    }
    if(result.accessDecision.verdict!=='allow'||!result.readiness.ready){
      const reason=result.readiness.blockers.map(item=>item.code).join(',')||result.accessDecision.reasonCode;
      throw new SessionAutomationConflictError('GOVERNANCE_DENIED',`automation governance denied: ${reason}`);
    }
  }
}

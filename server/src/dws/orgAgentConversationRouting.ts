import type {
  ExternalActorRef,
  OrgAgentWorkOrder,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';

const SHORT_ID_PATTERN = /(?:^|[\s#（(])((?:W)-[A-F0-9]{12})(?=$|[\s，。！？、）)])/i;
const OBVIOUS_CONTINUATION =
  /^(?:继续|接着|补充|追加|再做|改成|调整|暂停|恢复|复核|重试|转派|取消)(?:一下|这个|该|任务|刚才|上面|前面|：|:|，|,|\s|$)/u;

export interface OrgAgentConversationRouteHint {
  workOrder?: OrgAgentWorkOrder;
  clarification?: string;
}

export async function resolveOrgAgentConversationRouteHint(input: {
  store: OrgGroupAgentStore;
  tenantId: string;
  agentId: string;
  bindingId: string;
  workConversationId?: string;
  content: string;
  actor: ExternalActorRef;
}): Promise<OrgAgentConversationRouteHint> {
  const explicit = SHORT_ID_PATTERN.exec(input.content)?.[1]?.toUpperCase();
  if (explicit) {
    const work = await input.store.getWorkOrderByShortId(input.tenantId, input.agentId, explicit);
    if (work && work.bindingId === input.bindingId && visibleTo(work, input.actor))
      return { workOrder: work };
    return {
      clarification: `我找不到你可访问的任务 ${explicit}。请核对短号，或先让我列出当前话题的任务。`,
    };
  }
  if (!OBVIOUS_CONTINUATION.test(input.content.trim())) return {};
  const visible = (await input.store.listWorkOrders(input.tenantId, input.bindingId, 30)).filter(
    (work) => visibleTo(work, input.actor),
  );
  const conversationVisible = input.workConversationId
    ? visible.filter((work) => work.workConversationId === input.workConversationId)
    : visible;
  const active = conversationVisible.filter(
    (work) => !['completed', 'failed', 'cancelled'].includes(work.state),
  );
  const candidates = (active.length ? active : conversationVisible).slice(0, 5);
  if (input.workConversationId && candidates.length === 1) return { workOrder: candidates[0] };
  if (candidates.length > 0) return { clarification: clarificationFor(candidates) };
  return {};
}

function visibleTo(work: OrgAgentWorkOrder, actor: ExternalActorRef): boolean {
  if (work.visibility === 'conversation' && actor.assurance === 'mapped') return true;
  return (
    actor.provider === work.createdByActor.provider &&
    actor.corpId === work.createdByActor.corpId &&
    actor.openId === work.createdByActor.openId
  );
}

function clarificationFor(candidates: OrgAgentWorkOrder[]): string {
  const choices = candidates
    .map((work) => `${work.shortId}「${work.title.slice(0, 40)}」`)
    .join('、');
  return `我还不能确定你指哪项任务：${choices}。请回复/引用原任务消息，或带上任务短号再说一次。`;
}

import type { RenderItem } from '@agent/shared';

/** Match Web's result/deliverables/process split without introducing another raw-data renderer. */
export function partitionBusinessStepItems(items: readonly RenderItem[], systemActionIds: readonly string[] = []) {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const writes = new Set(systemActionIds);
  const interaction = (item: RenderItem) => item.type === 'permission_request' || item.type === 'ask_user';
  const deliverable = (item: RenderItem) => item.type === 'file_download' && !!item.artifactId;
  return {
    deliverables: unique.filter(deliverable),
    process: unique.filter((item) => !interaction(item) && !deliverable(item)),
    // Pending approvals/questions and external-system writes must remain visible in the conversation.
    inline: unique.filter((item) => interaction(item) || writes.has(item.id)),
  };
}

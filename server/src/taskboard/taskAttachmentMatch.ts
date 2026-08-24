export function sameTaskAttachments(
  existing: readonly { attachmentId?: string }[] | undefined,
  requested: readonly { attachmentId: string }[],
): boolean {
  const requestedIds = new Set(requested.map((attachment) => attachment.attachmentId));
  return requestedIds.size === requested.length && (existing?.length ?? 0) === requested.length
    && requested.every((attachment) => existing?.some((item) => item.attachmentId === attachment.attachmentId));
}

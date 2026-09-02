import {
  INCOMING_SHARE_STAGING_SAFETY_BYTES,
  assertIncomingSharePathFree,
  createIncomingShare,
  incomingShareKind,
  projectIncomingShareStatus,
  reduceAttachmentDraft,
  shareError,
  validateIncomingShareMagic,
  validateIncomingShareSelection,
  type AttachmentDraft,
  type CacheOwner,
  type IncomingShare,
} from '@agent/shared';

export interface IncomingShareSource {
  /** Permission-window reference; implementations must never persist or return it in canonical state. */
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface StagedShareSource {
  size: number;
  head: Uint8Array;
}

export interface IncomingSharePlatformAdapter {
  availableDiskBytes(): number | Promise<number>;
  stage(owner: CacheOwner, draft: AttachmentDraft, source: IncomingShareSource): Promise<StagedShareSource>;
  upload(owner: CacheOwner, draft: AttachmentDraft): Promise<{
    attachmentId: string;
    originalName: string;
    size: number;
    mimeType: string;
    isImage: boolean;
  }>;
  queryUpload(owner: CacheOwner, requestId: string): Promise<null | {
    attachmentId: string;
    originalName: string;
    size: number;
    mimeType: string;
    isImage: boolean;
  }>;
  release(owner: CacheOwner, draftId: string): Promise<void>;
}

/** Path-free owner-scoped persistence. The platform adapter owns the separate URI vault. */
export interface IncomingShareDraftStore {
  get(owner: CacheOwner, intentId: string): Promise<IncomingShare | null>;
  put(owner: CacheOwner, share: IncomingShare): Promise<void>;
  remove(owner: CacheOwner, intentId: string): Promise<void>;
  list(owner: CacheOwner): Promise<IncomingShare[]>;
}

function sameOwner(left: CacheOwner, right: CacheOwner): boolean {
  return left.userId === right.userId && left.tenantId === right.tenantId;
}

function uuid(): string {
  const randomUUID = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (!randomUUID) throw new Error('secure_random_unavailable');
  return randomUUID();
}

function failure(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT' || code === 'SOURCE_MISSING') return shareError('share_source_missing', false, true, '分享来源不存在，请重新选择');
  if (code === 'EACCES' || code === 'EPERM' || code === 'SOURCE_REVOKED') return shareError('share_source_revoked', false, true, '分享读取权限已失效，请重新选择');
  if (code === 'OFFLINE') return shareError('share_offline', true, false, '网络不可用，草稿已保留，可稍后重试');
  return shareError('share_upload_failed', true, false, error instanceof Error ? error.message : '上传失败，可重试');
}

/**
 * Canonical consume-once orchestration. Dedupe is owner + intentId; every attachment keeps one
 * requestId across offline/restart retries, so querying then replaying cannot create another attachment.
 */
export class IncomingShareCoordinator {
  private activeOwner: CacheOwner | null = null;
  private readonly inFlight = new Map<string, Promise<IncomingShare>>();

  constructor(
    private readonly store: IncomingShareDraftStore,
    private readonly adapter: IncomingSharePlatformAdapter,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = uuid,
  ) {}

  async consume(owner: CacheOwner, input: { intentId: string; text?: string; files: readonly IncomingShareSource[]; onSourcesStaged?: () => void }): Promise<IncomingShare> {
    this.assertOwner(owner);
    const key = `${owner.tenantId}:${owner.userId}:${input.intentId}`;
    const current = this.inFlight.get(key);
    if (current) return current;
    const operation = this.consumeOnce(owner, input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  private async consumeOnce(owner: CacheOwner, input: { intentId: string; text?: string; files: readonly IncomingShareSource[]; onSourcesStaged?: () => void }): Promise<IncomingShare> {
    const existing = await this.store.get(owner, input.intentId);
    if (existing) return this.resume(owner, existing);

    const attachments = input.files.map((source) => {
      const kind = incomingShareKind(source.mimeType);
      return {
        draftId: this.createId(),
        requestId: this.createId(),
        kind: kind === 'image' ? 'image' as const : 'pdf' as const,
        name: source.name,
        size: source.size,
        mimeType: source.mimeType.toLowerCase(),
      };
    });
    let share = createIncomingShare({ intentId: input.intentId, text: input.text, attachments, now: this.now() });
    await this.store.put(owner, share);

    const validated = validateIncomingShareSelection(input.files, input.text);
    if (!validated.ok) {
      share = { ...share, status: 'failed', error: validated.error,
        attachments: share.attachments.map((draft) => reduceAttachmentDraft(draft, { type: 'failed', error: validated.error })) };
      await this.store.put(owner, share);
      input.onSourcesStaged?.();
      return share;
    }

    if (share.attachments.length === 0) {
      share = { ...share, status: 'uploaded' };
      await this.store.put(owner, share);
      input.onSourcesStaged?.();
      return share;
    }

    for (let index = 0; index < share.attachments.length; index += 1) {
      let draft = reduceAttachmentDraft(share.attachments[index], { type: 'validate' });
      draft = reduceAttachmentDraft(draft, { type: 'validation_passed' });
      share = this.replace(share, index, draft);
      await this.store.put(owner, share);
      const required = draft.size + INCOMING_SHARE_STAGING_SAFETY_BYTES;
      if (await this.adapter.availableDiskBytes() < required) {
        draft = reduceAttachmentDraft(draft, { type: 'failed', error: shareError('share_low_disk', false, true, '设备可用空间不足，草稿已保留，请释放空间后重新选择') });
        share = this.replace(share, index, draft);
        await this.store.put(owner, share);
        continue;
      }
      try {
        const staged = await this.adapter.stage(owner, draft, input.files[index]);
        if (staged.size !== draft.size || !validateIncomingShareMagic(draft.mimeType, staged.head)) {
          await this.adapter.release(owner, draft.draftId);
          draft = reduceAttachmentDraft(draft, { type: 'failed', error: shareError('share_mime_mismatch', false, true, '文件真实类型与声明不一致，请重新选择') });
        }
      } catch (error) {
        draft = reduceAttachmentDraft(draft, { type: 'failed', error: failure(error) });
      }
      share = this.replace(share, index, draft);
      await this.store.put(owner, share);
    }
    input.onSourcesStaged?.();
    return this.resume(owner, share, false);
  }

  async resume(owner: CacheOwner, original: IncomingShare, retryFailed = true): Promise<IncomingShare> {
    this.assertOwner(owner);
    let share = original;
    if (this.now() >= Date.parse(share.expiresAt)) {
      for (const draft of share.attachments) await this.adapter.release(owner, draft.draftId).catch(() => undefined);
      share = { ...share, status: 'expired', attachments: share.attachments.map((draft) => reduceAttachmentDraft(draft, { type: 'expire' })) };
      await this.store.remove(owner, share.intentId);
      return share;
    }
    for (let index = 0; index < share.attachments.length; index += 1) {
      let draft = share.attachments[index];
      if (draft.status === 'uploaded' || draft.status === 'expired'
        || (draft.status === 'failed' && (!retryFailed || !draft.error?.retryable))) continue;
      try {
        const completed = await this.adapter.queryUpload(owner, draft.requestId);
        draft = completed
          ? reduceAttachmentDraft(draft, { type: 'uploaded', attachmentId: completed.attachmentId })
          : reduceAttachmentDraft(draft.status === 'failed' ? reduceAttachmentDraft(draft, { type: 'retry' }) : draft, { type: 'upload_started' });
        if (!completed && draft.status === 'uploading') {
          const uploaded = await this.adapter.upload(owner, draft);
          if (uploaded.originalName !== draft.name || uploaded.size !== draft.size || uploaded.mimeType !== draft.mimeType) {
            throw Object.assign(new Error('服务端返回的附件元数据不匹配'), { code: 'UPLOAD_METADATA_MISMATCH' });
          }
          draft = reduceAttachmentDraft(draft, { type: 'uploaded', attachmentId: uploaded.attachmentId });
        }
        if (draft.status === 'uploaded') await this.adapter.release(owner, draft.draftId);
      } catch (error) {
        draft = reduceAttachmentDraft(draft, { type: 'failed', error: failure(error) });
      }
      share = this.replace(share, index, draft);
      await this.store.put(owner, share);
    }
    share = { ...share, status: projectIncomingShareStatus(share.attachments, share.status) };
    assertIncomingSharePathFree(share);
    await this.store.put(owner, share);
    return share;
  }

  async cancel(owner: CacheOwner, share: IncomingShare): Promise<void> {
    this.assertOwner(owner);
    await Promise.all(share.attachments.map((draft) => this.adapter.release(owner, draft.draftId).catch(() => undefined)));
    await this.store.remove(owner, share.intentId);
  }

  async cleanup(owner: CacheOwner): Promise<number> {
    this.assertOwner(owner);
    const shares = await this.store.list(owner);
    const expired = shares.filter((share) => this.now() >= Date.parse(share.expiresAt));
    await Promise.all(expired.map((share) => this.cancel(owner, share)));
    return expired.length;
  }

  private replace(share: IncomingShare, index: number, draft: AttachmentDraft): IncomingShare {
    const attachments = [...share.attachments];
    attachments[index] = draft;
    const next = { ...share, attachments, status: projectIncomingShareStatus(attachments, share.status) };
    assertIncomingSharePathFree(next);
    return next;
  }

  private assertOwner(owner: CacheOwner): void {
    if (this.activeOwner && !sameOwner(this.activeOwner, owner)) {
      throw Object.assign(new Error('分享草稿属于其他账号'), { code: 'OWNER_CHANGED' });
    }
    this.activeOwner = { ...owner };
  }

  fenceOwner(): void {
    this.activeOwner = null;
    this.inFlight.clear();
  }
}

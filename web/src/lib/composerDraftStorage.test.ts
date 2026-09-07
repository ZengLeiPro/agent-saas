import { beforeEach, describe, expect, it } from "vitest";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import { clearAllComposerAttachmentDrafts, getComposerDraftScope, loadComposerAttachments, loadComposerText, prepareComposerAttachmentDrafts, saveComposerAttachments, saveComposerText } from "./composerDraftStorage";

const A1 = { userId: "user-1", tenantId: "tenant-a", generation: 1 };
const A2 = { ...A1, generation: 2 };
const B = { userId: "user-2", tenantId: "tenant-a", generation: 3 };
const TENANT_B = { userId: "user-1", tenantId: "tenant-b", generation: 4 };

describe("composerDraftStorage M20-04 boundary", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllComposerAttachmentDrafts();
  });

  it("isolates tenant, account and session drafts with canonical v2 keys", () => {
    const scopes = [A1, A2, B, TENANT_B].map(identity => getComposerDraftScope(identity, "s1"));
    expect(new Set(scopes).size).toBe(3);
    expect(scopes[0]).toBe(scopes[1]);
    expect(getComposerDraftScope(A1, "s1")).not.toBe(getComposerDraftScope(A1, "s2"));
  });

  it("keeps same-owner draft across auth generation for migration continuity", () => {
    const old = getComposerDraftScope(A1, "s1");
    const next = getComposerDraftScope(A2, "s1");
    saveComposerText(old, "old outbox/draft");
    expect(loadComposerText(next)).toBe("old outbox/draft");
  });

  it("fails closed for ownerless N-1 drafts", () => {
    localStorage.setItem(INPUT_DRAFT_KEY, "unknown owner");
    expect(loadComposerText(getComposerDraftScope(A1, null), true)).toBe("");
    expect(localStorage.getItem(INPUT_DRAFT_KEY)).toBeNull();
  });


  it("keeps only local draft URI metadata and clears uploaded attachment authority", () => {
    const local = { originalName: "local.png", relativePath: "content://picker/1", size: 1, mimeType: "image/png", isImage: true };
    const uploaded = { ...local, relativePath: "uploads/a.png", attachmentId: "server-attachment", savedPath: "workspace/uploads/a.png" };
    expect(prepareComposerAttachmentDrafts([local, uploaded])).toEqual([local]);
    expect(prepareComposerAttachmentDrafts([uploaded])).toEqual([]);
  });

  it("keeps uploaded attachment authority in session memory when switching composers", async () => {
    const newConversationScope = getComposerDraftScope(A1, null);
    const otherConversationScope = getComposerDraftScope(A1, "s1");
    const uploaded = {
      attachmentId: "server-attachment",
      originalName: "draft.png",
      savedPath: "workspace/uploads/draft.png",
      relativePath: "uploads/draft.png",
      size: 1,
      mimeType: "image/png",
      isImage: true,
      previewUrl: "blob:preview",
    };

    await saveComposerAttachments(newConversationScope, [uploaded]);
    await saveComposerAttachments(otherConversationScope, []);

    await expect(loadComposerAttachments(newConversationScope)).resolves.toEqual([{
      attachmentId: "server-attachment",
      originalName: "draft.png",
      savedPath: "workspace/uploads/draft.png",
      relativePath: "uploads/draft.png",
      size: 1,
      mimeType: "image/png",
      isImage: true,
    }]);
  });

  it("clears the session attachment draft only after an explicit empty save", async () => {
    const scope = getComposerDraftScope(A1, null);
    const uploaded = {
      attachmentId: "server-attachment",
      originalName: "draft.txt",
      savedPath: "workspace/uploads/draft.txt",
      relativePath: "uploads/draft.txt",
      size: 1,
      mimeType: "text/plain",
      isImage: false,
    };

    await saveComposerAttachments(scope, [uploaded]);
    await saveComposerAttachments(scope, []);

    await expect(loadComposerAttachments(scope)).resolves.toEqual([]);
  });

  it("IndexedDB unavailable degrades to empty attachment metadata", async () => {
    await expect(loadComposerAttachments(getComposerDraftScope(A1, "s1"))).resolves.toEqual([]);
    await expect(saveComposerAttachments(getComposerDraftScope(A1, "s1"), [])).resolves.toBeUndefined();
  });
});

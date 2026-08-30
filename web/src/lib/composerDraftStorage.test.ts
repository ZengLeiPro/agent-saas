import { beforeEach, describe, expect, it } from "vitest";
import { INPUT_DRAFT_KEY } from "@/lib/constants";
import { getComposerDraftScope, loadComposerAttachments, loadComposerText, saveComposerAttachments, saveComposerText } from "./composerDraftStorage";

const A1 = { userId: "user-1", tenantId: "tenant-a", generation: 1 };
const A2 = { ...A1, generation: 2 };
const B = { userId: "user-2", tenantId: "tenant-a", generation: 3 };
const TENANT_B = { userId: "user-1", tenantId: "tenant-b", generation: 4 };

describe("composerDraftStorage M20-04 boundary", () => {
  beforeEach(() => localStorage.clear());

  it("isolates account, tenant, generation and session drafts", () => {
    const scopes = [A1, A2, B, TENANT_B].map(identity => getComposerDraftScope(identity, "s1"));
    expect(new Set(scopes).size).toBe(4);
    expect(getComposerDraftScope(A1, "s1")).not.toBe(getComposerDraftScope(A1, "s2"));
  });

  it("does not expose a previous-generation draft", () => {
    const old = getComposerDraftScope(A1, "s1");
    const next = getComposerDraftScope(A2, "s1");
    saveComposerText(old, "old outbox/draft");
    expect(loadComposerText(next)).toBe("");
  });

  it("fails closed for ownerless N-1 drafts", () => {
    localStorage.setItem(INPUT_DRAFT_KEY, "unknown owner");
    expect(loadComposerText(getComposerDraftScope(A1, null), true)).toBe("");
    expect(localStorage.getItem(INPUT_DRAFT_KEY)).toBeNull();
  });

  it("IndexedDB unavailable degrades to empty attachment metadata", async () => {
    await expect(loadComposerAttachments(getComposerDraftScope(A1, "s1"))).resolves.toEqual([]);
    await expect(saveComposerAttachments(getComposerDraftScope(A1, "s1"), [])).resolves.toBeUndefined();
  });
});

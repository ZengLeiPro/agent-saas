import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { generateUserId, USER_ID_PATTERN, UserStore } from "../data/users/store.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  while (cleanupRoots.length) {
    const root = cleanupRoots.pop()!;
    await rm(root, { recursive: true, force: true });
  }
});

async function tempUserStore(): Promise<{ store: UserStore; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-saas-users-"));
  cleanupRoots.push(root);
  const filePath = join(root, "users.json");
  return { store: new UserStore(filePath), filePath };
}

describe("UserStore user ids", () => {
  it("generates compact ky-prefixed user ids", () => {
    const id = generateUserId();
    expect(id).toMatch(USER_ID_PATTERN);
    expect(id).toHaveLength(14);
  });

  it("persists new users with compact ids", async () => {
    const { store, filePath } = await tempUserStore();

    const user = await store.create({
      username: "alice",
      password: "password123",
      role: "user",
      createdBy: "system",
      tenantId: "kaiyan",
    });

    expect(user.id).toMatch(USER_ID_PATTERN);
    expect(user.id).toHaveLength(14);
    expect(user.preferences).toEqual({
      authorizationModeEnabled: true,
      sidebarLayout: "single",
      showSessionListAvatar: false,
    });

    const reloaded = new UserStore(filePath);
    const persisted = reloaded.findById(user.id);
    expect(persisted?.username).toBe("alice");
    expect(persisted?.preferences).toEqual({
      authorizationModeEnabled: true,
      sidebarLayout: "single",
      showSessionListAvatar: false,
    });
  });
});

describe("UserStore phone uniqueness", () => {
  it("enforces phone globally across phone fields and phone-like usernames", async () => {
    const { store } = await tempUserStore();
    const alice = await store.create({
      username: "alice",
      password: "password123",
      role: "user",
      createdBy: "system",
      tenantId: "kaiyan",
      phone: "13800001111",
    });
    const bob = await store.create({
      username: "bob",
      password: "password123",
      role: "user",
      createdBy: "system",
      tenantId: "kaiyan",
    });

    await expect(
      store.create({
        username: "charlie",
        password: "password123",
        role: "user",
        createdBy: "system",
        tenantId: "kaiyan",
        phone: "13800001111",
      }),
    ).rejects.toThrow("Phone already exists");

    await expect(
      store.create({
        username: "13800001111",
        password: "password123",
        role: "user",
        createdBy: "system",
        tenantId: "kaiyan",
      }),
    ).rejects.toThrow("Phone already exists");

    await expect(
      store.update(bob.id, { phone: "13800001111" }),
    ).rejects.toThrow("Phone already exists");

    expect(store.findAllByPhone("13800001111").map((u) => u.id)).toEqual([
      alice.id,
    ]);
  });

  it("treats a phone-like username as a phone owner", async () => {
    const { store } = await tempUserStore();
    const user = await store.create({
      username: "13900001111",
      password: "password123",
      role: "user",
      createdBy: "system",
      tenantId: "kaiyan",
      phone: "13900001111",
    });

    expect(store.findByPhone("13900001111")?.id).toBe(user.id);
    await expect(
      store.create({
        username: "alice",
        password: "password123",
        role: "user",
        createdBy: "system",
        tenantId: "kaiyan",
        phone: "13900001111",
      }),
    ).rejects.toThrow("Phone already exists");
  });

  it("clears phone verification when phone is manually changed", async () => {
    const { store } = await tempUserStore();
    const user = await store.create({
      username: "alice",
      password: "password123",
      role: "user",
      createdBy: "system",
      tenantId: "kaiyan",
      phone: "13800001111",
      phoneVerifiedAt: "2026-01-01T00:00:00.000Z",
    });

    const updated = await store.update(user.id, { phone: "13900001111" });
    expect(updated.phone).toBe("13900001111");
    expect(updated.phoneVerifiedAt).toBeUndefined();
  });
});

describe("UserStore tenant admin safety", () => {
  it("counts active admins per tenant", async () => {
    const { store } = await tempUserStore();
    await store.create({
      username: "platform_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: DEFAULT_TENANT_ID,
    });
    await store.create({
      username: "wain_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: "wain",
    });

    expect(store.activeAdminCount()).toBe(2);
    expect(store.activeAdminCount(DEFAULT_TENANT_ID)).toBe(1);
    expect(store.activeAdminCount("wain")).toBe(1);
  });

  it("does not delete the last active admin in a tenant", async () => {
    const { store } = await tempUserStore();
    await store.create({
      username: "platform_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: DEFAULT_TENANT_ID,
    });
    const wainAdmin = await store.create({
      username: "wain_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: "wain",
    });

    await expect(store.delete(wainAdmin.id)).rejects.toThrow(
      "Cannot delete the last admin",
    );
  });

  it("does not disable the last active admin in a tenant", async () => {
    const { store } = await tempUserStore();
    const platformAdmin = await store.create({
      username: "platform_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: DEFAULT_TENANT_ID,
    });
    const wainAdmin = await store.create({
      username: "wain_admin",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: "wain",
    });

    await expect(
      store.setDisabled(wainAdmin.id, true, platformAdmin.id),
    ).rejects.toThrow("Cannot disable the last active admin");
  });

  it("allows deleting an admin when the tenant keeps another active admin", async () => {
    const { store } = await tempUserStore();
    const first = await store.create({
      username: "wain_admin_a",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: "wain",
    });
    await store.create({
      username: "wain_admin_b",
      password: "password123",
      role: "admin",
      createdBy: "system",
      tenantId: "wain",
    });

    await store.delete(first.id);
    expect(store.findById(first.id)).toBeUndefined();
    expect(store.activeAdminCount("wain")).toBe(1);
  });
});

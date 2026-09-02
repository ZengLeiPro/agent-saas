import { beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/types/auth";
import {
  clearSavedAccounts,
  forgetSavedAccount,
  forgetSavedAccountByToken,
  getAccountKey,
  getSavedAccountToken,
  readSavedAccounts,
  rememberSavedAccount,
} from "./savedAccounts";

const binding = { authEpoch: 1, generation: 1 };

const firstUser: AuthUser = {
  id: "user-1",
  username: "first",
  role: "user",
  tenantId: "tenant-a",
};

const secondUser: AuthUser = {
  id: "user-2",
  username: "second",
  role: "admin",
  tenantId: "tenant-b",
};

describe("savedAccounts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("按最近使用顺序保存账号，并更新同一账号的 token", () => {
    rememberSavedAccount("token-1", firstUser, binding);
    rememberSavedAccount("token-2", secondUser, binding);
    rememberSavedAccount("token-1-new", { ...firstUser, realName: "新名称" }, { authEpoch: 2, generation: 2 });

    expect(readSavedAccounts()).toEqual([
      { key: getAccountKey(firstUser), user: { ...firstUser, realName: "新名称" } },
      { key: getAccountKey(secondUser), user: secondUser },
    ]);
    expect(getSavedAccountToken(getAccountKey(firstUser))).toBe("token-1-new");
  });

  it("失效 token 只移除对应账号，退出登录可清空全部账号", () => {
    rememberSavedAccount("token-1", firstUser, binding);
    rememberSavedAccount("token-2", secondUser, binding);

    expect(forgetSavedAccountByToken("token-2")).toEqual([
      { key: getAccountKey(firstUser), user: firstUser },
    ]);

    rememberSavedAccount("token-2", secondUser, binding);
    expect(forgetSavedAccount(getAccountKey(firstUser))).toEqual([
      { key: getAccountKey(secondUser), user: secondUser },
    ]);

    clearSavedAccounts();
    expect(readSavedAccounts()).toEqual([]);
  });
});

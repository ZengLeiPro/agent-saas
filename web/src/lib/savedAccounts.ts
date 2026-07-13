import type { AuthUser } from "@/types/auth";

const SAVED_ACCOUNTS_KEY = "agentChat.savedAccounts.v1";

interface SavedAccountRecord {
  key: string;
  token: string;
  user: AuthUser;
}

export interface SavedAccountSummary {
  key: string;
  user: AuthUser;
}

export function getAccountKey(user: Pick<AuthUser, "id" | "tenantId">): string {
  return `${user.tenantId}:${user.id}`;
}

function isSavedAccountRecord(value: unknown): value is SavedAccountRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SavedAccountRecord>;
  return (
    typeof record.key === "string" &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    !!record.user &&
    typeof record.user.id === "string" &&
    typeof record.user.username === "string" &&
    typeof record.user.tenantId === "string" &&
    (record.user.role === "admin" || record.user.role === "user")
  );
}

function readRecords(): SavedAccountRecord[] {
  try {
    const raw = localStorage.getItem(SAVED_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSavedAccountRecord) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: SavedAccountRecord[]): void {
  try {
    if (records.length === 0) {
      localStorage.removeItem(SAVED_ACCOUNTS_KEY);
      return;
    }
    localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(records));
  } catch {
    // localStorage 不可用时仍允许当前账号正常登录，只是不保留多账号列表。
  }
}

function toSummaries(records: SavedAccountRecord[]): SavedAccountSummary[] {
  return records.map(({ key, user }) => ({ key, user }));
}

export function readSavedAccounts(): SavedAccountSummary[] {
  return toSummaries(readRecords());
}

export function rememberSavedAccount(token: string, user: AuthUser): SavedAccountSummary[] {
  const key = getAccountKey(user);
  const records = [
    { key, token, user },
    ...readRecords().filter((record) => record.key !== key),
  ];
  writeRecords(records);
  return toSummaries(records);
}

export function getSavedAccountToken(key: string): string | null {
  return readRecords().find((record) => record.key === key)?.token ?? null;
}

export function forgetSavedAccountByToken(token: string): SavedAccountSummary[] {
  const records = readRecords().filter((record) => record.token !== token);
  writeRecords(records);
  return toSummaries(records);
}

export function forgetSavedAccount(key: string): SavedAccountSummary[] {
  const records = readRecords().filter((record) => record.key !== key);
  writeRecords(records);
  return toSummaries(records);
}

export function clearSavedAccounts(): void {
  try {
    localStorage.removeItem(SAVED_ACCOUNTS_KEY);
  } catch {
    // 与 writeRecords 同理：存储不可用不应阻断退出登录。
  }
}

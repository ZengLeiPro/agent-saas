import type { AuthUser, LoginCredentials, SmsLoginCredentials } from "@/types/auth";
import { apiUrl } from "@/lib/apiBase";

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

async function postLogin(path: string, body: unknown): Promise<AuthResponse> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "登录失败");
  }
  return res.json() as Promise<AuthResponse>;
}

export function loginWithPassword(credentials: LoginCredentials): Promise<AuthResponse> {
  return postLogin("/api/auth/login", credentials);
}

export function loginWithSmsCode(credentials: SmsLoginCredentials): Promise<AuthResponse> {
  return postLogin("/api/auth/sms/login", credentials);
}

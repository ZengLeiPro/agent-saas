import type { SessionAutomationCommandRequest, SessionAutomationCommandResponse, SessionAutomationControlRequest, SessionAutomationListResponse, SessionAutomationSnapshot, SessionAutomationApiErrorBody } from '../types/sessionAutomation.js';
export class SessionAutomationApiError extends Error {
  constructor(readonly status: number, readonly body: SessionAutomationApiErrorBody) { super(body.message); }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json() as T | SessionAutomationApiErrorBody;
  if (!response.ok) throw new SessionAutomationApiError(response.status, body as SessionAutomationApiErrorBody);
  return body as T;
}
export const sessionAutomationsApi = {
  list: (sessionId: string) => request<SessionAutomationListResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/automations`),
  get: (sessionId: string, automationId: string) => request<SessionAutomationSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/automations/${encodeURIComponent(automationId)}`),
  command: (sessionId: string, input: SessionAutomationCommandRequest) => request<SessionAutomationCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/automations/commands`, { method: 'POST', body: JSON.stringify(input) }),
  control: (sessionId: string, automationId: string, input: SessionAutomationControlRequest) => request<SessionAutomationCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/automations/${encodeURIComponent(automationId)}/control`, { method: 'POST', body: JSON.stringify(input) }),
};

import { ModelProviderError } from '../types.js';
import { ResponsesStreamGuardError } from './responsesStreamBudget.js';
import { compactDiagnosticMessage } from '../responsesAttemptDiagnostics.js';
import { isPermanentGrokProtocolError } from './grokProtocol.js';

export function isPermanentTransportError(error: unknown): boolean {
  if (error instanceof ResponsesStreamGuardError) return true;
  if (isPermanentGrokProtocolError(error)) return true;
  if (error instanceof ModelProviderError) {
    return (
      error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404
    );
  }
  const message = compactDiagnosticMessage(error);
  if (/Codex subscription (?:transport 未启用|尚未完成账号授权)/i.test(message)) return true;
  if (
    /Codex (?:OAuth )?(?:凭据(?:格式损坏|字段不完整)|token 缺少|Responses endpoint|originator)/i.test(
      message,
    )
  ) {
    return true;
  }
  const oauthHttpStatus = /Codex OAuth .*HTTP (\d{3})/i.exec(message)?.[1];
  if (oauthHttpStatus) {
    const status = Number(oauthHttpStatus);
    return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
  }
  return false;
}

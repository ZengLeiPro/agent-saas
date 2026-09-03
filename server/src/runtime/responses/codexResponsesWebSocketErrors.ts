export class CodexWebSocketUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'CodexWebSocketUnavailableError';
  }
}

export class CodexWebSocketQuotaExhaustedError extends CodexWebSocketUnavailableError {
  readonly status = 429;
  readonly code: string;

  constructor(message: string, code?: string) {
    super(message, 'quota_exhausted');
    this.name = 'CodexWebSocketQuotaExhaustedError';
    this.code = code ?? 'quota_exhausted';
  }
}

export class CodexWebSocketCredentialStaleError extends Error {
  readonly reason = 'credential_generation_stale';

  constructor(
    readonly credentialRef: string,
    readonly credentialGeneration: number,
    readonly observedGeneration: number,
  ) {
    super(
      `Codex credential generation ${credentialGeneration} is older than observed generation ${observedGeneration}`,
    );
    this.name = 'CodexWebSocketCredentialStaleError';
  }
}

export class CodexWebSocketAccountUnavailableError extends Error {
  readonly status = 403;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CodexWebSocketAccountUnavailableError';
  }
}

export class CodexWebSocketReanchorError extends Error {
  constructor(readonly code: string) {
    super(`Codex WebSocket requires full-history re-anchor: ${code}`);
    this.name = 'CodexWebSocketReanchorError';
  }
}

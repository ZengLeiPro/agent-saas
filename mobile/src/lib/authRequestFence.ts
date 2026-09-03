export interface AuthRequestBoundary {
  generation: number;
  apiOrigin: string;
}

export class StaleAuthRequestError extends Error {
  constructor() {
    super('认证请求所属的身份或服务已变化');
    this.name = 'StaleAuthRequestError';
  }
}

export function captureAuthRequestBoundary(
  generation: number,
  apiOrigin: string | null | undefined,
): AuthRequestBoundary {
  if (!apiOrigin) throw new StaleAuthRequestError();
  return { generation, apiOrigin };
}

export function assertAuthRequestBoundary(
  expected: AuthRequestBoundary,
  currentGeneration: number,
  currentApiOrigin: string | null | undefined,
): void {
  if (
    currentGeneration !== expected.generation
    || currentApiOrigin !== expected.apiOrigin
  ) {
    throw new StaleAuthRequestError();
  }
}

export class KyAppPlatformError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KyAppPlatformError';
  }
}

export async function platformRequest<T>(input: {
  baseUrl: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { message?: unknown } | undefined;
    throw new KyAppPlatformError(
      response.status,
      typeof error?.message === 'string' ? error.message : `平台返回 HTTP ${response.status}`,
    );
  }
  return payload as T;
}

export async function platformFormRequest<T>(input: {
  baseUrl: string;
  token: string;
  path: string;
  body: FormData;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.token}` },
    body: input.body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error;
    const message =
      typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown } | undefined)?.message === 'string'
          ? String((error as { message: string }).message)
          : `平台返回 HTTP ${response.status}`;
    throw new KyAppPlatformError(response.status, message);
  }
  return payload as T;
}

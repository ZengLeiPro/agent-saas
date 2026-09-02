/** Keep bearer grants out of application logs while preserving a useful route label. */
export function requestTargetForLog(request: { path: string; originalUrl: string }): string {
  if (request.path === '/preview' || request.path.startsWith('/preview/')) {
    return '/preview/[REDACTED]';
  }
  return request.originalUrl;
}
